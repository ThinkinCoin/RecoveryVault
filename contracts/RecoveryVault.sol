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

    // =====================
    // ===== Constants =====
    // =====================
    uint256 public constant ROUND_DELAY = 24 hours;
    uint256 public constant WALLET_RESET_INTERVAL = 24 hours;

    // =====================
    // =====  Storage  =====
    // =====================
    address public immutable wONE;
    address public immutable usdc;
    address public devWallet;
    address public rmcWallet;
    bytes32 public merkleRoot;
    uint256 public currentRound;
    uint256 public roundStart;
    uint256 public dailyLimitUsd; // whole USD (no decimals)
    bool public isLocked;

    IOracle public oracle;

    mapping(address => bool) public supportedToken;
    address[] public supportedTokenList;

    // Usage per user per round, in whole USD
    mapping(uint256 => mapping(address => uint256)) public redeemedInRound;
    mapping(address => uint256) public lastRedeemTimestamp;

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
        address resolvedTokenIn = tokenIn;

        // Accept native ONE -> wrap to wONE
        if (tokenIn == address(0)) {
            require(msg.value == amountIn, "Mismatch ONE amount");
            require(wONE != address(0), "wONE not configured");
            IWETH(wONE).deposit{value: amountIn}();
            resolvedTokenIn = wONE;
        } else {
            require(msg.value == 0, "Do not send ONE with ERC20");
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // Policy: input must be supported; output must be wONE or USDC
        require(supportedToken[resolvedTokenIn], "Token not supported");
        require(redeemIn == wONE || redeemIn == usdc, "Redeem token must be wONE or USDC");

        // Daily limit checks (based on USD integer of the *input* amount)
        uint256 usdValueIn = _usdValueFor(resolvedTokenIn, amountIn);
        _resetIfNeeded(msg.sender);
        uint256 usedUsd = redeemedInRound[currentRound][msg.sender];
        uint256 remaining = dailyLimitUsd > usedUsd ? dailyLimitUsd - usedUsd : 0;
        require(usdValueIn <= remaining, "Exceeds daily limit");
        redeemedInRound[currentRound][msg.sender] = usedUsd + usdValueIn;

        // Fee selection by USD tiers (bps), fee applied in tokenIn units
        uint256 feeTokenIn = _calculateFee(amountIn, usdValueIn);
        uint256 netIn = amountIn - feeTokenIn;

        // Convert net USD value to redeem token amount
        uint256 usdValueNet = _usdValueFor(resolvedTokenIn, netIn);
        uint8 redeemDec = IERC20Metadata(redeemIn).decimals();
        uint256 priceOut18 = _priceOut18(redeemIn);
        // amountOut = usdValueNet * 1e18 * 10**redeemDec / priceOut18 (floor)
        uint256 amountOut = (usdValueNet * 1e18 * (10 ** redeemDec)) / priceOut18;

        // Liquidity check for redeem token
        require(IERC20(redeemIn).balanceOf(address(this)) >= amountOut, "Insufficient liquidity");

        // Transfers: fee -> dev, net -> rmc (burn/off-ramp), out -> user
        IERC20(resolvedTokenIn).safeTransfer(devWallet, feeTokenIn);
        IERC20(resolvedTokenIn).safeTransfer(rmcWallet, netIn);
        IERC20(redeemIn).safeTransfer(msg.sender, amountOut);

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

        tokenInDecimals = IERC20Metadata(tokenIn).decimals();
        redeemInDecimals = IERC20Metadata(redeemIn).decimals();

        (int256 _price, uint8 _decimals) = oracle.latestPrice();
        require(_price > 0, "Invalid oracle");
        oraclePrice = uint256(_price);
        oracleDecimals = _decimals;

        // USD integer valuation for input amount
        usdValueIn = _usdValueFor(tokenIn, amountIn);

        // Daily limit window
        uint256 redeemed = redeemedInRound[currentRound][user];
        if (block.timestamp - lastRedeemTimestamp[user] >= WALLET_RESET_INTERVAL) {
            redeemed = 0;
        }
        userLimitUsdBefore = dailyLimitUsd > redeemed ? dailyLimitUsd - redeemed : 0;
        require(usdValueIn <= userLimitUsdBefore, "Exceeds daily limit");
        userLimitUsdAfter = userLimitUsdBefore - usdValueIn;

        // Fee and net input (tokenIn units)
        uint256 fee = _calculateFee(amountIn, usdValueIn);
        feeAmountInTokenIn = fee;
        burnAmountInTokenIn = amountIn - fee;

        // Compute amountOut in redeem token based on net USD
        uint256 usdValueNet = _usdValueFor(tokenIn, burnAmountInTokenIn);
        uint256 priceOut18 = _priceOut18(redeemIn);
        amountOutRedeemToken = (usdValueNet * 1e18 * (10 ** redeemInDecimals)) / priceOut18;
    }

    // =====================
    // ======  Views  ======
    // =====================
    function getUserLimit(address wallet) external view returns (uint256 remainingUSD) {
        uint256 redeemed = redeemedInRound[currentRound][wallet];
        if (block.timestamp - lastRedeemTimestamp[wallet] >= WALLET_RESET_INTERVAL) {
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
        uint256 limitUsd
    ) {
        (uint256 w, uint256 u) = getVaultBalances();
        return (
            currentRound,
            roundStart,
            !isLocked && block.timestamp >= roundStart && (w > 0 || u > 0),
            isLocked,
            dailyLimitUsd
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
        roundStart = block.timestamp + ROUND_DELAY;
        emit NewRoundStarted(_roundId, w, u, roundStart);
    }

    // =====================
    // ===== Internals =====
    // =====================
    function _calculateFee(uint256 amountIn, uint256 usdValue) internal view returns (uint256) {
        for (uint i = 0; i < feeThresholds.length; i++) {
            if (usdValue <= feeThresholds[i]) {
                return (amountIn * feeBps[i]) / 10_000;
            }
        }
        return (amountIn * feeBps[feeBps.length - 1]) / 10_000; // fallback tier
    }

    function _usdValueFor(address token, uint256 amount) internal view returns (uint256 usdInt) {
        if (token == wONE) {
            uint8 dec = IERC20Metadata(token).decimals();
            (int256 _p, uint8 _d) = oracle.latestPrice();
            require(_p > 0, "Invalid oracle");
            uint256 p = uint256(_p);
            // amount -> 1e18 base, then multiply by USD/ONE price and scale back to integer USD
            uint256 one18 = amount * 1e18 / (10 ** dec);
            usdInt = (one18 * p) / (10 ** _d) / 1e18;
        } else if (token == usdc) {
            uint8 usdcDec = IERC20Metadata(usdc).decimals();
            usdInt = amount / (10 ** usdcDec);
        } else if (fixedUsdPrice[token] > 0) {
            uint8 dec = IERC20Metadata(token).decimals();
            usdInt = (amount * fixedUsdPrice[token]) / (10 ** dec) / 1e18;
        } else {
            revert("Unsupported valuation");
        }
    }

    function _priceOut18(address token) internal view returns (uint256 price18) {
        if (token == usdc) {
            return 1e18; // 1 USD per USDC
        } else if (token == wONE) {
            (int256 _p, uint8 _d) = oracle.latestPrice();
            require(_p > 0, "Invalid oracle");
            // price18 = oraclePrice * 1e18 / 10**oracleDecimals
            return uint256(_p) * 1e18 / (10 ** _d);
        } else {
            revert("Unsupported redeem token");
        }
    }

    function _verifyWhitelist(address user, bytes32[] calldata proof) internal view returns (bool) {
        return MerkleProof.verify(proof, merkleRoot, keccak256(abi.encodePacked(user)));
    }

    function _resetIfNeeded(address user) internal {
        if (block.timestamp - lastRedeemTimestamp[user] >= WALLET_RESET_INTERVAL) {
            redeemedInRound[currentRound][user] = 0;
        }
        lastRedeemTimestamp[user] = block.timestamp;
    }
}
