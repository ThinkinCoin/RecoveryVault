// test/integration/Integration.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Integration - Full redeem flow", () => {
  let vault, wONE, usdc, oracle, devWallet, rmcWallet, user;

  beforeEach(async () => {
    const [owner, userSigner, dev, rmc] = await ethers.getSigners();
    user = userSigner;
    devWallet = dev;
    rmcWallet = rmc;

    const Token = await ethers.getContractFactory("ERC20Mock");
    wONE = await Token.deploy("Wrapped ONE", "wONE", 18);
    usdc = await Token.deploy("USD Coin", "USDC", 6);

    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy("820000", 6); // 0.82 USD per ONE

    const RecoveryVault = await ethers.getContractFactory("RecoveryVault");
    vault = await RecoveryVault.deploy(
      owner.address,
      dev.address,
      rmc.address,
      wONE.address,
      usdc.address,
      [usdc.address, wONE.address],
      200,
      oracle.address
    );
  });

  it("should calculate correct fee tier", async () => {
    const usdAmount = 250;
    const bps = await vault.getFeeTiers();
    expect(bps.thresholds).to.include(250);
  });

  it("should fail redeem if usdValue exceeds limit", async () => {
    const proof = [];
    await vault.startNewRound(1);
    await ethers.provider.send("evm_increaseTime", [25 * 3600]);
    await ethers.provider.send("evm_mine");

    await expect(
      vault.connect(user).quoteRedeem(user.address, wONE.address, ethers.utils.parseEther("10"), wONE.address, proof)
    ).to.be.revertedWith("Exceeds daily limit");
  });
});
