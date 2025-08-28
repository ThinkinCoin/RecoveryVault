#!/usr/bin/env node
// scripts/deploy.js
/* eslint-disable no-console */
const { ethers, run, network } = require('hardhat');
const config = require('./config.json');

const HARMONY_CHAIN_ID = 1666600000n;
const ONE_GWEI = 1_000_000_000n;

function roundUpToGwei(v) {
  const x = BigInt(v);
  return ((x + ONE_GWEI - 1n) / ONE_GWEI) * ONE_GWEI;
}
function bump(value, num = 125n, den = 100n) {
  // ~ +25%
  return (BigInt(value) * num) / den;
}

async function pickLegacyFees(provider) {
  // Try feeData.gasPrice -> bump -> round; fallback to 200 gwei
  const fee = await provider.getFeeData().catch(() => ({}));
  const base = fee?.gasPrice != null ? BigInt(fee.gasPrice) : 0n;

  // sane floor for Harmony (adjust if needed)
  const floor = ethers.parseUnits('200', 'gwei'); // 200 gwei
  let gasPrice = base > 0n ? bump(base) : floor;

  // ensure >= floor and rounded in gwei
  gasPrice = roundUpToGwei(gasPrice < floor ? floor : gasPrice);
  return { gasPrice, type: 0 }; // legacy
}

async function estimateDeployGas(deployer, txReq, overrides = {}) {
  try {
    const req = { ...txReq, ...overrides, from: await deployer.getAddress() };
    const est = await deployer.estimateGas(req);
    return (est * 120n) / 100n; // +20%
  } catch (err) {
    console.warn('⚠️ estimateGas failed or not supported, using fallback 5,000,000');
    return 5_000_000n;
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    console.error('❌ No deployer account found. Check network configuration.');
    process.exit(1);
  }

  const net = await ethers.provider.getNetwork();
  const chainId = BigInt(net.chainId);
  const isHarmony = chainId === HARMONY_CHAIN_ID;

  const initialOwner = await deployer.getAddress();
  const devWallet = initialOwner;

  const rmcWallet = config.RECOVERY?.rmcWallet;
  const wONE = config.RECOVERY?.wONE;
  const peggedUSDC = config.RECOVERY?.peggedUSDC;
  const oracleAddress = config.RECOVERY?.oracle;
  const dailyLimitUsd = ethers.parseUnits(config.RECOVERY?.dailyLimitUsd || '100', 18);

  const rawTokens = config.RECOVERY?.supportedTokens || [];
  const supportedTokens = [...new Set(
    rawTokens.filter((addr) => {
      if (!addr) return false;
      const valid = ethers.isAddress(addr);
      if (!valid) console.warn(`⚠️ Invalid token skipped: ${addr}`);
      return valid;
    })
  )];

  if (!supportedTokens.length) {
    console.error('❌ No valid supported token addresses found. Aborting.');
    process.exit(1);
  }

  const Factory = await ethers.getContractFactory('RecoveryVault');

  // === fee overrides ===
  let feeOverrides = {};
  if (isHarmony) {
    // Harmony is safest with legacy gas
    feeOverrides = await pickLegacyFees(ethers.provider);
  } else {
    // Non-Harmony: try EIP-1559 first, fallback to legacy
    const fee = await ethers.provider.getFeeData().catch(() => ({}));
    if (fee?.maxFeePerGas && fee?.maxPriorityFeePerGas) {
      const mfp = roundUpToGwei(bump(fee.maxFeePerGas));
      const tip = roundUpToGwei(bump(fee.maxPriorityFeePerGas));
      feeOverrides = { maxFeePerGas: mfp, maxPriorityFeePerGas: tip, type: 2 };
    } else {
      feeOverrides = await pickLegacyFees(ethers.provider);
    }
  }

  // === gasLimit estimate ===
  console.log('🚀 Deploying RecoveryVault with owner:', initialOwner);
  const deployTxReq = Factory.getDeployTransaction(
    initialOwner,
    devWallet,
    rmcWallet,
    wONE,
    peggedUSDC,
    supportedTokens,
    dailyLimitUsd,
    oracleAddress
  );

  const gasLimit = await estimateDeployGas(deployer, deployTxReq, feeOverrides);

  // === send deployment ===
  const overrides = { ...feeOverrides, gasLimit };

  console.log(
    `ℹ️ Network: ${net.name} (chainId ${net.chainId}) | ` +
    (overrides.type === 0
      ? `legacy gasPrice=${overrides.gasPrice?.toString()}`
      : `maxFeePerGas=${overrides.maxFeePerGas?.toString()}, maxPriorityFeePerGas=${overrides.maxPriorityFeePerGas?.toString()}`) +
    ` | gasLimit=${overrides.gasLimit?.toString()}`
  );

  const vault = await Factory.deploy(
    initialOwner,
    devWallet,
    rmcWallet,
    wONE,
    peggedUSDC,
    supportedTokens,
    dailyLimitUsd,
    oracleAddress,
    overrides
  );

  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log(`✅ Deployed RecoveryVault at ${address}`);

  const confirmations = chainId === 1n ? 6 : 1;
  const depTx = await vault.deploymentTransaction();
  await depTx.wait(confirmations);

  // Optional: Verify
  try {
    await run('verify:verify', {
      address,
      constructorArguments: [
        initialOwner,
        devWallet,
        rmcWallet,
        wONE,
        peggedUSDC,
        supportedTokens,
        dailyLimitUsd,
        oracleAddress
      ],
      contract: 'contracts/RecoveryVault.sol:RecoveryVault'
    });
    console.log('✅ Verification complete!');
  } catch (err) {
    console.warn('⚠️ Verification failed or skipped:', err?.message || String(err));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
