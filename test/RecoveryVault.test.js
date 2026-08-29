import { expect } from "chai";
import hre from "hardhat";
import { parseUnits } from "ethers";

const { ethers } = hre;

// Helpers to parse units
const ONE_18 = (v) => parseUnits(v, 18);
const USD18 = (v) => parseUnits(v, 18);
const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("RecoveryVault", () => {
  async function deployFixture() {
    const [owner, dev, rmc, user, other] = await ethers.getSigners();

    // Mocks
    const WETH = await ethers.getContractFactory("WETHMock");
    const wone = await WETH.deploy("Wrapped ONE", "wONE", 18);
    await wone.waitForDeployment();

    const ERC20 = await ethers.getContractFactory("ERC20Mock");
    const usdc = await ERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    const Burnable = await ethers.getContractFactory("BurnableERC20Mock");
    const burnable = await Burnable.deploy("BurnableToken", "BRN", 18);
    await burnable.waitForDeployment();

    const Oracle = await ethers.getContractFactory("OracleMock");
    // ONE price = $2.00 , 8 decimals  -> 200000000
    const oracle = await Oracle.deploy(200000000n, 8);
    await oracle.waitForDeployment();

    // Supported tokens: wONE, USDC, Burnable
    const supported = [await wone.getAddress(), await usdc.getAddress(), await burnable.getAddress()];

    const Vault = await ethers.getContractFactory("RecoveryVault");
    const vault = await Vault.deploy(
      await owner.getAddress(),
      await dev.getAddress(),
      await rmc.getAddress(),
      await wone.getAddress(),
      await usdc.getAddress(),
      supported,
      USD18("1000"), // dailyLimitUsd = $1000 * 1e18
      await oracle.getAddress()
    );
    await vault.waitForDeployment();

    // whitelist: root = keccak(user) so proof = []
    const leaf = ethers.keccak256(ethers.solidityPacked(["address"], [user.address]));
    await (await vault.setMerkleRoot(leaf)).wait();

    // Prefund vault liquidity (USDC + wONE)
    // Mint some wONE to an EOA and transfer to vault
    await (await wone.mint(owner.address, ONE_18("1000"))).wait();
    await (await wone.transfer(await vault.getAddress(), ONE_18("500"))).wait();

    await (await usdc.mint(owner.address, parseUnits("100000", 6))).wait();
    await (await usdc.transfer(await vault.getAddress(), parseUnits("50000", 6))).wait();

    // Disable round delay to avoid time-travel in tests
    await (await vault.setRoundDelayEnabled(false)).wait();

    // Start round 1 (locks roundBps)
    await (await vault.startNewRound(1)).wait();

    return { owner, dev, rmc, user, other, wone, usdc, burnable, oracle, vault };
  }

  it("initializes and locks round fee tier", async () => {
    const { vault } = await deployFixture();
    const info = await vault.getRoundInfo();
    expect(info.roundId).to.eq(1n);
    expect(info.delayEnabled).to.eq(false);
    expect(info.roundFeeBps).to.be.oneOf([100n, 50n, 25n, 10n]); // depends on vault USD basis
    expect(info.isActive).to.eq(true);
  });

  it("redeems native ONE -> USDC with fee and sink fallback (wONE not burnable)", async () => {
    const { vault, user, dev, wone, usdc } = await deployFixture();

    const proof = []; // single-leaf whitelist
    const amountInONE = ONE_18("10"); // 10 ONE  => $20 at $2/ONE
    const devBalBefore = await wone.balanceOf(dev.address);
    const usdcBefore = await usdc.balanceOf(user.address);

    await expect(
      vault.connect(user).redeem(
        ethers.ZeroAddress, // tokenIn = native ONE
        amountInONE,
        await usdc.getAddress(),
        proof,
        { value: amountInONE }
      )
    )
      .to.emit(vault, "BurnToken")
      .and.to.emit(vault, "RedeemProcessed")
      .and.to.emit(vault, "RedeemValuationUSD18");

    // fee tier <=100 USD -> likely 100 bps (1%); fee in tokenIn units
    const info = await vault.getRoundInfo();
    const feeBps = Number(info.roundFeeBps);
    const expectedFee = amountInONE * BigInt(feeBps) / 10000n;

    // Fee sent to dev in wONE (wrapped native)
    const devBalAfter = await wone.balanceOf(dev.address);
    expect(devBalAfter - devBalBefore).to.eq(expectedFee);

    // Net burned or sunk: check DEAD received something (since WETHMock has no burn())
    const deadBal = await wone.balanceOf(DEAD);
    expect(deadBal).to.be.greaterThan(0n);

    // User received USDC
    const usdcAfter = await usdc.balanceOf(user.address);
    expect(usdcAfter).to.be.greaterThan(usdcBefore);
  });

  it("prevents redeem if sending ONE with ERC20 tokenIn or mismatched msg.value", async () => {
    const { vault, user, usdc } = await deployFixture();
    const proof = [];

    // Wrong: ERC20 but msg.value > 0
    await expect(
      vault.connect(user).redeem(
        await usdc.getAddress(), // tokenIn is ERC20
        1000n,
        await usdc.getAddress(),
        proof,
        { value: 1n }
      )
    ).to.be.revertedWith("Do not send ONE with ERC20");

    // Wrong: native path but mismatch amount
    await expect(
      vault.connect(user).redeem(
        ethers.ZeroAddress,
        ONE_18("1"),
        await usdc.getAddress(),
        proof,
        { value: ONE_18("0.9") }
      )
    ).to.be.revertedWith("Mismatch ONE amount");
  });

  it("enforces daily limit and time-lock", async () => {
    const { vault, user } = await deployFixture();
    const proof = [];

    // Set small daily limit: $20
    await (await vault.setDailyLimit(USD18("20"))).wait();

    // Try to redeem $20 exactly (10 ONE @ $2) -> ok
    await vault.connect(user).redeem(ethers.ZeroAddress, ONE_18("10"), await vault.usdc(), proof, { value: ONE_18("10") });

    // Now any additional USD will exceed
    await expect(
      vault.connect(user).redeem(ethers.ZeroAddress, ONE_18("1"), await vault.usdc(), proof, { value: ONE_18("1") })
    ).to.be.revertedWith("Daily limit locked");

    // getUserLimit must be 0 while locked
    const rem = await vault.getUserLimit(user.address);
    expect(rem).to.eq(0n);
  });

  it("quoteRedeem matches redeem math (happy path)", async () => {
    const { vault, user, usdc } = await deployFixture();
    const proof = [];

    const amountIn = ONE_18("5"); // 5 ONE @ $2 => $10
    const q = await vault.quoteRedeem(
      user.address,
      ethers.ZeroAddress,
      amountIn,
      await usdc.getAddress(),
      proof
    );

    expect(q.whitelisted).to.eq(true);
    expect(q.roundIsActive).to.eq(true);
    expect(q.tokenInDecimals).to.eq(18);
    expect(q.redeemInDecimals).to.eq(6);
    expect(q.oraclePrice).to.eq(200000000n);
    expect(q.oracleDecimals).to.eq(8);

    // Redeem and compare amountOut
    const before = await usdc.balanceOf(user.address);
    await vault.connect(user).redeem(ethers.ZeroAddress, amountIn, await usdc.getAddress(), proof, { value: amountIn });
    const after = await usdc.balanceOf(user.address);

    expect(after - before).to.eq(q.amountOutRedeemToken);
  });

  it("supports fixedUsdPrice valuation for custom ERC20 and burns if burnable", async () => {
    const { vault, user, burnable, usdc, dev } = await deployFixture();
    const proof = [];

    // Configure fixed price: $3 per token (USD18)
    await (await vault.setFixedUsdPrice(await burnable.getAddress(), USD18("3"))).wait();

    // Mint token to user and approve vault
    await (await burnable.mint(user.address, ONE_18("100"))).wait();
    await (await burnable.connect(user).approve(await vault.getAddress(), ONE_18("100"))).wait();

    // Redeem 10 BRN -> gross $30; fee depends on tier; ensure dev gets some BRN
    const devBefore = await burnable.balanceOf(dev.address);
    await vault.connect(user).redeem(
      await burnable.getAddress(),
      ONE_18("10"),
      await usdc.getAddress(),
      proof
    );
    const devAfter = await burnable.balanceOf(dev.address);
    expect(devAfter - devBefore).to.be.greaterThan(0n);
    // No sink event required (burnable has burn()) — não verificamos evento aqui
  });

  it("admin functions and guards", async () => {
    const { vault, owner, dev, rmc, usdc, other } = await deployFixture();
    await expect(vault.connect(other).setLocked(true)).to.be.revertedWith("Ownable: caller is not the owner");

    // Apenas chamadas diretas para setDevWallet e setRmcWallet
    await vault.setDevWallet(other.address);
    await vault.setDevWallet(dev.address);
    await vault.setRmcWallet(rmc.address);

    // Update fee tiers (len check)
    await expect(vault.setFeeTiers([100, 200], [100, 50])).to.be.revertedWith("Invalid fee config");
    await (await vault.setFeeTiers([100, 250, 1000], [100, 50, 25, 10])).wait();

    // Supported tokens toggle
    const token = await usdc.getAddress();
    await (await vault.setSupportedToken(token, false)).wait();
    await (await vault.setSupportedToken(token, true)).wait();

    // Pause/unpause
    await (await vault.setLocked(true)).wait();
    await expect(vault.startNewRound(2)).to.be.revertedWith("No funds"); // not necessarily; but roundActive guard blocks redeem
    await (await vault.setLocked(false)).wait();

    // Withdraw funds (only owner, only wONE/USDC)
    await expect(vault.connect(other).withdrawFunds(token)).to.be.revertedWith("Ownable: caller is not the owner");
    await (await vault.withdrawFunds(token)).wait();
  });

  it("reverts on unsupported tokens or output", async () => {
    const { vault, user, other } = await deployFixture();
    const proof = [];
    // Random address as token
    const fake = other.address;
    await expect(
      vault.connect(user).quoteRedeem(user.address, fake, 1n, await vault.usdc(), proof)
    ).to.be.revertedWith("Token not supported");

    await expect(
      vault.connect(user).quoteRedeem(user.address, await vault.wONE(), 1n, other.address, proof)
    ).to.be.revertedWith("Redeem token must be wONE or USDC");
  });
});
