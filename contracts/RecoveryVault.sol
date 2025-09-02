// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

// @dev RecoveryVault: non-1:1 redeem; output only wONE/USDC; fee in tokenIn; USD-integer accounting.
import {Ownable} from "./hub/access/Ownable.sol";
import {IERC20} from "./hub/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "./hub/token/ERC20/extensions/IERC20Metadata.sol";
import {MerkleProof} from "./hub/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "./hub/security/ReentrancyGuard.sol";
import {SafeERC20} from "./hub/token/ERC20/utils/SafeERC20.sol";

/// @notice Oracle must return price of ONE in USD with `decimals` precision
interface IOracle {
    function latestPrice() external view returns (int256 price, uint8 decimals);
}

/// @notice Minimal wONE interface to wrap native ONE
interface IWETH {
    function deposit() external payable;
}

/// @dev Optional burnable interface. Many tokens expose `burn(uint256)` on holder balance.
interface IERC20Burnable {
    function burn(uint256 value) external;
}

contract RecoveryVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =====================
    // ====== Events  ======
    // =====================
    event BurnToken(address indexed tokenIn, uint256 amountIn, address refundToken, uint256 amountOut);
    event NewRoundStarted(uint256 roundId, uint256 woneBalance, uint256 usdcBalance, uint256 startTime);
    event RedeemProcessed(address indexed user, address indexed tokenIn, uint256 amountIn, uint256 amountOut);
    event VaultPaused(bool isPaused);
    event SupportedTokenUpdated(address token, bool allowed);
    event FeeTiersUpdated(uint256[] thresholds, uint16[] bps);
    event RoundFeeLocked(uint256 indexed roundId, uint16 bps, uint256 basisUsd);
    event RoundDelayToggled(bool enabled);

    // =====================
    // ===== Constants =====
    // =====================
    uint256 public constant ROUND_DELAY = 24 hours;
    uint256 public constant WALLET_RESET_INTERVAL = 24 hours;
    address public constant DEAD_BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD; // sink address

    // =====================
    // =====  Storage  =====
    // =====================
    address public immutable wONE;
    address public immutable usdc;
    uint8 public immutable WONE_DECIMALS;
    uint8 public immutable USDC_DECIMALS;

    address public devWallet;
    address public rmcWallet; // kept for withdrawals / ops, not used for burning anymore
    bytes32 public merkleRoot;
    uint256 public currentRound;
    uint256 public roundStart;
    uint256 public dailyLimitUsd; // whole USD (no decimals)
    bool public isLocked;

    // Round config
    bool public roundDelayEnabled = true; // owner can toggle
    uint16 public roundBps;              // fixed fee for current round
    bool public roundFeeLocked;          // true after startNewRound sets roundBps
    uint256 public roundFeeBasisUsd;     // USD (integer) basis used to pick the tier at round start

    IOracle public oracle;

    mapping(address => bool) public supportedToken;
    address[] public supportedTokenList;

    // Usage per user per round, in whole USD
    mapping(uint256 => mapping(address => uint256)) public redeemedInRound;
    mapping(address => uint256) public lastRedeemTimestamp; // informational only
    mapping(address => uint256) public limitUnlockAt;       // if > now, wallet is locked at daily limit
    mapping(address => uint256) public periodStart;         // anchor for rolling 24h window

    // Fixed price table for supported tokens other than wONE/USDC. Scale: 1e18 (USD * 1e18 per whole token)
    mapping(address => uint256) public fixedUsdPrice;

    // Fee tiers: thresholds in whole USD, bps as fee per ten-thousand. bps.length = thresholds.length + 1
    uint256[] public feeThresholds = [100, 250, 1000];
    uint16[] public feeBps = [100, 50, 25, 10];

    // =====================
    // ====  Modifiers  ====
    // =====================
    modifier onlyWhitelisted(bytes32[] calldata proof) {
        require(_verifyWhitelist(msg.sender, proof), "Not whitelisted");
        _;
    }

    modifier roundActive() {
        // Prevent pre-round usage when roundStart == 0
        require(currentRound > 0, "Round not initialized");
        require(!isLocked, "Contract is locked");
        require(block.timestamp >= roundStart, "Round not started");
        (uint256 w, uint256 u) = getVaultBalances();
        require(w > 0 || u > 0, "No funds");
        _;
    }

    // =====================
    // ==== Constructor  ===
    // =====================
    constructor(
        address _owner,
        address _devWallet,
        address _rmcWallet,
        address _wone,
        address _usdc,
        address[] memory _supportedTokens,
        uint256 _dailyLimitUsd,
        address _oracle
    ) {
        _transferOwnership(_owner);
        devWallet = _devWallet;
        rmcWallet = _rmcWallet;
        wONE = _wone;
        usdc = _usdc;
        dailyLimitUsd = _dailyLimitUsd; // whole USD
        oracle = IOracle(_oracle);

        // cache decimals as immutables for gas
        WONE_DECIMALS = IERC20Metadata(_wone).decimals();
        USDC_DECIMALS = IERC20Metadata(_usdc).decimals();

        for (uint i = 0; i < _supportedTokens.length; i++) {
            supportedToken[_supportedTokens[i]] = true;
            supportedTokenList.push(_supportedTokens[i]);
            emit SupportedTokenUpdated(_supportedTokens[i], true);
        }
    }

    // =====================
    // ======  Core   ======
    // =====================
    function redeem(
        address tokenIn,
        uint256 amountIn,
        address redeemIn,
        bytes32[] calldata proof
    ) external payable nonReentrant roundActive onlyWhitelisted(proof) {
        // Derive resolved token **without** moving funds yet
        address resolvedTokenIn = (tokenIn == address(0)) ? wONE : tokenIn;

        // Basic value checks but **defer** transfers/wrap until all validations pass
        if (tokenIn == address(0)) {
            require(msg.value == amountIn, "Mismatch ONE amount");
            require(wONE != address(0), "wONE not configured");
        } else {
            require(msg.value == 0, "Do not send ONE with ERC20");
        }

        // Policy: input must be supported; output must be wONE or USDC
        require(supportedToken[resolvedTokenIn], "Token not supported");
        require(redeemIn == wONE || redeemIn == usdc, "Redeem token must be wONE or USDC");

        // Daily-limit lock guard
        if (limitUnlockAt[msg.sender] != 0) {
            require(block.timestamp >= limitUnlockAt[msg.sender], "Daily limit locked");
        }

        // Reset window if needed; also handle rolling window anchor
        _resetIfNeeded(msg.sender);
        if (periodStart[msg.sender] == 0) {
            periodStart[msg.sender] = block.timestamp;
        }

        // Fetch oracle once for this flow
        (int256 _p, uint8 _d) = oracle.latestPrice();
        require(_p > 0, "Invalid oracle");
        uint256 p = uint256(_p);

        // Determine tokenIn decimals (cache if known)
        uint8 tokenInDec = resolvedTokenIn == wONE
            ? WONE_DECIMALS
            : (resolvedTokenIn == usdc ? USDC_DECIMALS : IERC20Metadata(resolvedTokenIn).decimals());

        // Compute USD usage for this request (USD integer)
        uint256 usdValueIn = _usdValueForWithDec(resolvedTokenIn, amountIn, tokenInDec, p, _d);
        uint256 usedUsd = redeemedInRound[currentRound][msg.sender];
        uint256 remaining = dailyLimitUsd > usedUsd ? dailyLimitUsd - usedUsd : 0;
        require(usdValueIn <= remaining, "Exceeds daily limit");

        // Fee selection (round-fixed if locked), and net input
        uint256 feeTokenIn = _calculateFee(amountIn, usdValueIn);
        uint256 netIn = amountIn - feeTokenIn;

        // Quote output amount on **net** value (no state/fund movement yet)
        uint256 usdValueNet = _usdValueForWithDec(resolvedTokenIn, netIn, tokenInDec, p, _d);
        uint8 redeemDec = (redeemIn == usdc) ? USDC_DECIMALS : WONE_DECIMALS;
        uint256 priceOut18 = _priceOut18With(redeemIn, p, _d);
        uint256 amountOut = (usdValueNet * 1e18 * (10 ** redeemDec)) / priceOut18; // floor

        // Liquidity check for redeem token
        require(IERC20(redeemIn).balanceOf(address(this)) >= amountOut, "Insufficient liquidity");

        // === All validations passed — now move funds ===
        if (tokenIn == address(0)) {
            IWETH(wONE).deposit{value: amountIn}();
        } else {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // Transfers: fee -> dev, net -> burn/sink, out -> user
        IERC20(resolvedTokenIn).safeTransfer(devWallet, feeTokenIn);
        _burnOrSink(resolvedTokenIn, netIn);
        IERC20(redeemIn).safeTransfer(msg.sender, amountOut);

        // Update usage & timers only after successful transfers
        uint256 newUsed = usedUsd + usdValueIn;
        redeemedInRound[currentRound][msg.sender] = newUsed;
        if (newUsed == dailyLimitUsd) {
            // lock lasts until end of the current 24h window
            uint256 anchor = periodStart[msg.sender] == 0 ? block.timestamp : periodStart[msg.sender];
            limitUnlockAt[msg.sender] = anchor + WALLET_RESET_INTERVAL;
        }
        lastRedeemTimestamp[msg.sender] = block.timestamp;

        emit BurnToken(resolvedTokenIn, amountIn, redeemIn, amountOut);
        emit RedeemProcessed(msg.sender, resolvedTokenIn, amountIn, amountOut);
    }

    /// @notice Returns the last timestamp when the user performed a redeem.
    function getLastRedeemTimestamp(address user) external view returns (uint256) {
        return lastRedeemTimestamp[user];
    }

    function quoteRedeem(
        address user,
        address tokenIn,
        uint256 amountIn,
        address redeemIn,
        bytes32[] calldata proof
    ) public view returns (
        bool whitelisted,
        bool roundIsActive,
        uint256 feeAmountInTokenIn,
        uint256 burnAmountInTokenIn,
        uint256 userLimitUsdBefore,
        uint256 userLimitUsdAfter,
        uint256 usdValueIn,
        uint8 tokenInDecimals,
        uint8 redeemInDecimals,
        uint256 oraclePrice,
        uint8 oracleDecimals,
        uint256 amountOutRedeemToken
    ) {
        whitelisted = _verifyWhitelist(user, proof);
        roundIsActive = !isLocked && block.timestamp >= roundStart;

        require(supportedToken[tokenIn], "Token not supported");
        require(redeemIn == wONE || redeemIn == usdc, "Redeem token must be wONE or USDC");

        // cache decimals without external call when known
        tokenInDecimals = tokenIn == wONE
            ? WONE_DECIMALS
            : (tokenIn == usdc ? USDC_DECIMALS : IERC20Metadata(tokenIn).decimals());
        redeemInDecimals = (redeemIn == usdc) ? USDC_DECIMALS : WONE_DECIMALS;

        (int256 _price, uint8 _decimals) = oracle.latestPrice();
        require(_price > 0, "Invalid oracle");
        oraclePrice = uint256(_price);
        oracleDecimals = _decimals;

        // USD integer valuation for input amount
        usdValueIn = _usdValueForWithDec(tokenIn, amountIn, tokenInDecimals, oraclePrice, oracleDecimals);

        // Remaining limit computation (non-reverting UI path)
        uint256 redeemed = redeemedInRound[currentRound][user];
        // apply rolling window if elapsed
        if (periodStart[user] != 0 && block.timestamp >= periodStart[user] + WALLET_RESET_INTERVAL) {
            redeemed = 0;
        }
        uint256 remainingBefore = dailyLimitUsd > redeemed ? dailyLimitUsd - redeemed : 0;
        bool isTimeLocked = (limitUnlockAt[user] != 0 && block.timestamp < limitUnlockAt[user]);

        if (isTimeLocked || usdValueIn > remainingBefore) {
            userLimitUsdBefore = 0;
            userLimitUsdAfter = 0;
            feeAmountInTokenIn = 0;
            burnAmountInTokenIn = 0;
            amountOutRedeemToken = 0;
            return (
                whitelisted,
                roundIsActive,
                feeAmountInTokenIn,
                burnAmountInTokenIn,
                userLimitUsdBefore,
                userLimitUsdAfter,
                usdValueIn,
                tokenInDecimals,
                redeemInDecimals,
                oraclePrice,
                oracleDecimals,
                amountOutRedeemToken
            );
        }

        userLimitUsdBefore = remainingBefore;
        userLimitUsdAfter = remainingBefore - usdValueIn;

        // Fee and net input (tokenIn units)
        uint256 fee = _calculateFee(amountIn, usdValueIn);
        feeAmountInTokenIn = fee;
        burnAmountInTokenIn = amountIn - fee;

        // Compute amountOut in redeem token based on net USD
        uint256 usdValueNet = _usdValueForWithDec(tokenIn, burnAmountInTokenIn, tokenInDecimals, oraclePrice, oracleDecimals);
        uint256 priceOut18 = _priceOut18With(redeemIn, oraclePrice, oracleDecimals);
        amountOutRedeemToken = (usdValueNet * 1e18 * (10 ** redeemInDecimals)) / priceOut18;
    }

    // =====================
    // ======  Views  ======
    // =====================
    function getUserLimit(address wallet) external view returns (uint256 remainingUSD) {
        if (limitUnlockAt[wallet] != 0 && block.timestamp < limitUnlockAt[wallet]) {
            return 0;
        }
        uint256 redeemed = redeemedInRound[currentRound][wallet];
        if (periodStart[wallet] != 0 && block.timestamp >= periodStart[wallet] + WALLET_RESET_INTERVAL) {
            redeemed = 0;
        }
        remainingUSD = dailyLimitUsd > redeemed ? dailyLimitUsd - redeemed : 0;
    }

    function getVaultBalances() public view returns (uint256 woneBalance, uint256 usdcBalance) {
        woneBalance = IERC20(wONE).balanceOf(address(this));
        usdcBalance = IERC20(usdc).balanceOf(address(this));
    }

    function getRoundInfo() external view returns (
        uint256 roundId,
        uint256 startTime,
        bool isActive,
        bool paused,
        uint256 limitUsd,
        bool delayEnabled,
        uint16 roundFeeBps,
        uint256 roundFeeBasis
    ) {
        (uint256 w, uint256 u) = getVaultBalances();
        return (
            currentRound,
            roundStart,
            !isLocked && block.timestamp >= roundStart && (w > 0 || u > 0),
            isLocked,
            dailyLimitUsd,
            roundDelayEnabled,
            roundBps,
            roundFeeBasisUsd
        );
    }

    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokenList;
    }

    function getFeeTiers() external view returns (uint256[] memory thresholds, uint16[] memory bps) {
        return (feeThresholds, feeBps);
    }

    // =====================
    // ====== Admins  ======
    // =====================
    function setMerkleRoot(bytes32 _root) external onlyOwner {
        merkleRoot = _root;
    }

    function setSupportedToken(address token, bool allowed) external onlyOwner {
        supportedToken[token] = allowed;
        bool exists;
        for (uint i = 0; i < supportedTokenList.length; i++) {
            if (supportedTokenList[i] == token) {
                exists = true;
                if (!allowed) {
                    supportedTokenList[i] = supportedTokenList[supportedTokenList.length - 1];
                    supportedTokenList.pop();
                }
                break;
            }
        }
        if (!exists && allowed) {
            supportedTokenList.push(token);
        }
        emit SupportedTokenUpdated(token, allowed);
    }

    function setLocked(bool _status) external onlyOwner {
        isLocked = _status;
        emit VaultPaused(_status);
    }

    function setDailyLimit(uint256 usdAmount) external onlyOwner {
        dailyLimitUsd = usdAmount;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = IOracle(_oracle);
    }

    function setDevWallet(address wallet) external onlyOwner {
        devWallet = wallet;
    }

    function setRmcWallet(address wallet) external onlyOwner {
        rmcWallet = wallet;
    }

    function setFeeTiers(uint256[] calldata thresholds, uint16[] calldata bps) external onlyOwner {
        require(thresholds.length + 1 == bps.length, "Invalid fee config");
        feeThresholds = thresholds;
        feeBps = bps;
        emit FeeTiersUpdated(thresholds, bps);
    }

    function setFixedUsdPrice(address token, uint256 usdPrice18) external onlyOwner {
        require(supportedToken[token], "Not supported");
        fixedUsdPrice[token] = usdPrice18; // 1e18 = $1.00
    }

    function setRoundDelayEnabled(bool enabled) external onlyOwner {
        roundDelayEnabled = enabled;
        emit RoundDelayToggled(enabled);
    }

    function withdrawFunds(address token) external onlyOwner {
        require(token == wONE || token == usdc, "Token not allowed");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Nothing to withdraw");
        IERC20(token).safeTransfer(rmcWallet, balance);
    }

    function startNewRound(uint256 _roundId) external onlyOwner {
        require(_roundId > currentRound, "Round ID must increase");
        (uint256 w, uint256 u) = getVaultBalances();
        require(w > 0 || u > 0, "No funds");
        currentRound = _roundId;
        roundStart = block.timestamp + (roundDelayEnabled ? ROUND_DELAY : 0);

        // Lock a single fee tier for the whole round, based on current vault USD value
        (int256 _p, uint8 _d) = oracle.latestPrice();
        require(_p > 0, "Invalid oracle");
        uint256 p = uint256(_p);
        uint256 basisUsd = _usdValueForWithDec(wONE, w, WONE_DECIMALS, p, _d)
            + _usdValueForWithDec(usdc, u, USDC_DECIMALS, p, _d);
        roundBps = _selectBpsByUsd(basisUsd);
        roundFeeBasisUsd = basisUsd;
        roundFeeLocked = true;

        emit RoundFeeLocked(_roundId, roundBps, basisUsd);
        emit NewRoundStarted(_roundId, w, u, roundStart);
    }

    // =====================
    // ===== Internals =====
    // =====================
    function _calculateFee(uint256 amountIn, uint256 usdValueIn) internal view returns (uint256) {
        uint16 bps = roundFeeLocked ? roundBps : _selectBpsByUsd(usdValueIn);
        return (amountIn * bps) / 10_000;
    }

    function _selectBpsByUsd(uint256 usdValue) internal view returns (uint16) {
        for (uint i = 0; i < feeThresholds.length; i++) {
            if (usdValue <= feeThresholds[i]) {
                return feeBps[i];
            }
        }
        return feeBps[feeBps.length - 1];
    }

    /// @dev USD integer (floor) for `amount` of `token`, using provided decimals and oracle price.
    function _usdValueForWithDec(
        address token,
        uint256 amount,
        uint8 tokenDecimals,
        uint256 oraclePrice,
        uint8 oracleDecimals
    ) internal view returns (uint256 usdInt) {
        if (token == wONE) {
            uint256 one18 = amount * 1e18 / (10 ** tokenDecimals);
            usdInt = (one18 * oraclePrice) / (10 ** oracleDecimals) / 1e18;
        } else if (token == usdc) {
            usdInt = amount / (10 ** tokenDecimals); // 1 USD per USDC
        } else if (fixedUsdPrice[token] > 0) {
            usdInt = (amount * fixedUsdPrice[token]) / (10 ** tokenDecimals) / 1e18;
        } else {
            revert("Unsupported valuation");
        }
    }

    /// @dev Price in 1e18 scale for redeem token using provided oracle price/decimals.
    function _priceOut18With(address token, uint256 oraclePrice, uint8 oracleDecimals) internal view returns (uint256 price18) {
        if (token == usdc) {
            return 1e18; // 1 USD per USDC
        } else if (token == wONE) {
            return oraclePrice * 1e18 / (10 ** oracleDecimals);
        } else {
            revert("Unsupported redeem token");
        }
    }

    function _verifyWhitelist(address user, bytes32[] calldata proof) internal view returns (bool) {
        return MerkleProof.verify(proof, merkleRoot, keccak256(abi.encodePacked(user)));
    }

    function _resetIfNeeded(address user) internal {
        // 1) If a time-lock is set and elapsed, clear lock and usage
        if (limitUnlockAt[user] != 0 && block.timestamp >= limitUnlockAt[user]) {
            redeemedInRound[currentRound][user] = 0;
            limitUnlockAt[user] = 0;
            periodStart[user] = 0;
            return;
        }
        // 2) Rolling 24h window: if window elapsed, reset usage and anchor
        if (periodStart[user] != 0 && block.timestamp >= periodStart[user] + WALLET_RESET_INTERVAL) {
            redeemedInRound[currentRound][user] = 0;
            periodStart[user] = 0;
        }
    }

    function _burnOrSink(address token, uint256 amount) internal {
        if (amount == 0) return;
        // try burn(uint256) if available
        (bool ok, ) = token.call(abi.encodeWithSignature("burn(uint256)", amount));
        if (ok) return;
        // fallback: send to a well-known burn sink (cannot transfer to address(0) on standard ERC20)
        IERC20(token).safeTransfer(DEAD_BURN_ADDRESS, amount);
    }
}
