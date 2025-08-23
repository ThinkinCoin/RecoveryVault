// test/integration/RecoveryVault.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = ethers;

describe("RecoveryVault - Integration (ERC20 and native ONE)", function () {
  let vault, oracle, wONE, usdc, owner, user, devWallet, rmcWallet;

  beforeEach(async () => {
    [owner, user, devWallet, rmcWallet] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("ERC20Mock");
    usdc = await MockERC20.deploy("USDC", "USDC", 6);
    wONE = await MockERC20.deploy("Wrapped ONE", "wONE", 18);

    const MockOracle = await ethers.getContractFactory("MockOracle");
    oracle = await MockOracle.deploy(parseUnits("0.82", 6), 6); // 1 ONE = 0.82 USD

    const RecoveryVault = await ethers.getContractFactory("RecoveryVault");
    vault = await RecoveryVault.deploy(
      owner.address,
      devWallet.address,
      rmcWallet.address,
      wONE.address,
      usdc.address,
      [usdc.address, wONE.address],
      100,
      oracle.address
    );
  });

  it("should store and update dailyLimitUsd in whole USD", async () => {
    expect(await vault.dailyLimitUsd()).to.equal(100);
    await vault.setDailyLimit(250);
    expect(await vault.dailyLimitUsd()).to.equal(250);
  });

  it("should accept native ONE, convert to wONE, and calculate usdValue correctly", async () => {
    const VaultAsUser = vault.connect(user);

    const proof = []; // use empty for now, whitelist check is stubbed in mock
    await expect(() =>
      VaultAsUser.redeem(
        ethers.constants.AddressZero,
        parseUnits("1", 18),
        wONE.address,
        proof,
        { value: parseUnits("1", 18) }
      )
    ).to.changeEtherBalance(user, parseUnits("-1", 18));
  });
});
