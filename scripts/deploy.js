#!/usr/bin/env node
/* eslint-disable no-console */
const { ethers, run } = require('hardhat');
const config = require('./config.json');

const HARMONY_CHAIN_ID = 1666600000n;
const ONE_GWEI = 1_000_000_000n;

function roundUpToGwei(v) {
  const x = BigInt(v);
  return ((x + ONE_GWEI - 1n) / ONE_GWEI) * ONE_GWEI;
}
function bump(value, num = 125n, den = 100n) {
  return (BigInt(value) * num) / den; // ~ +25%
}

async function pickLegacyFees(provider) {
  const fee = await provider.getFeeData().catch(() => ({}));
  const base = fee?.gasPrice != null ? BigInt(fee.gasPrice) : 0n;
  const floor = ethers.parseUnits('200', 'gwei'); // ajuste se necessário
  let gasPrice = base > 0n ? bump(base) : floor;
  gasPrice = roundUpToGwei(gasPrice < floor ? floor : gasPrice);
  return { gasPrice, type: 0 }; // legacy
}

async function estimateDeployGas(deployer, txReq, overrides = {}) {
  try {
    const req = { ...txReq, ...overrides, from: await deployer.getAddress() };
    const est = await deployer.estimateGas(req);
    return (est * 120n) / 100n; // +20%
  } catch {
    console.warn('⚠️ estimateGas falhou, usando fallback 5,000,000');
    return 5_000_000n;
  }
}

function toLower(a) { return (a || '').toString().toLowerCase(); }

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    console.error('❌ Sem deployer. Confira a config da network.');
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

  // dailyLimitUsd no contrato é inteiro (USD sem decimais).
  // Se o seu config guarda como "100" (sem casas), pode usar direto como BigInt.
  // Se prefere manter como string, também funciona.
  const dailyLimitUsd =
    config.RECOVERY?.dailyLimitUsd != null
      ? BigInt(String(config.RECOVERY.dailyLimitUsd))
      : 100n;

  const rawTokens = config.RECOVERY?.supportedTokens || [];
  const supportedTokens = [...new Set(
    rawTokens.filter((addr) => {
      if (!addr) return false;
      const valid = ethers.isAddress(addr);
      if (!valid) console.warn(`⚠️ Token inválido ignorado: ${addr}`);
      return valid;
    })
  )];

  if (!supportedTokens.length) {
    console.error('❌ Nenhum token suportado válido. Abortando.');
    process.exit(1);
  }

  const Factory = await ethers.getContractFactory('RecoveryVault');

  // --- Fee overrides (mantido como estava) ---
  let feeOverrides = {};
  if (isHarmony) {
    feeOverrides = await pickLegacyFees(ethers.provider);
  } else {
    const fee = await ethers.provider.getFeeData().catch(() => ({}));
    if (fee?.maxFeePerGas && fee?.maxPriorityFeePerGas) {
      const mfp = roundUpToGwei(bump(fee.maxFeePerGas));
      const tip = roundUpToGwei(bump(fee.maxPriorityFeePerGas));
      feeOverrides = { maxFeePerGas: mfp, maxPriorityFeePerGas: tip, type: 2 };
    } else {
      feeOverrides = await pickLegacyFees(ethers.provider);
    }
  }

  // --- Deploy ---
  console.log('🚀 Deploying RecoveryVault com owner:', initialOwner);
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

  // --- (NOVO) Configurar fixedUsdPrice para tokens suportados ---
  // Espera-se no config:
  // RECOVERY.fixedPrices: {
  //   "0xTokenA": "1.00",
  //   "0xTokenB": "0.5"
  // }
  const fixedPrices = config.RECOVERY?.fixedPrices || {};
  const hasFixed = fixedPrices && typeof fixedPrices === 'object' && Object.keys(fixedPrices).length > 0;

  if (hasFixed) {
    console.log('🧩 Configurando fixedUsdPrice...');
    // Mapa rápido pra checar se o token está em supportedTokens
    const allowed = new Set(supportedTokens.map(toLower));
    for (const [tokenAddr, priceStr] of Object.entries(fixedPrices)) {
      if (!ethers.isAddress(tokenAddr)) {
        console.warn(`⚠️ fixedPrices: endereço inválido ignorado: ${tokenAddr}`);
        continue;
      }
      if (!allowed.has(toLower(tokenAddr))) {
        console.warn(`⚠️ fixedPrices: ${tokenAddr} não está em supportedTokens; ignorando.`);
        continue;
      }
      const raw = String(priceStr ?? '').trim();
      if (!raw) {
        console.warn(`⚠️ fixedPrices: valor vazio para ${tokenAddr}; ignorando.`);
        continue;
      }
      // O contrato espera 18 decimais (USD * 1e18 por 1 token)
      // Aceitamos "1", "1.0", "0.5" etc. e convertemos para 1e18.
      let usdPrice18;
      try {
        usdPrice18 = ethers.parseUnits(raw, 18);
      } catch (e) {
        console.warn(`⚠️ fixedPrices: valor inválido "${raw}" para ${tokenAddr}; ignorando.`);
        continue;
      }

      try {
        const tx = await vault.setFixedUsdPrice(tokenAddr, usdPrice18, overrides);
        console.log(` → setFixedUsdPrice(${tokenAddr}, ${usdPrice18.toString()}) tx=${tx.hash}`);
        await tx.wait(confirmations);
      } catch (e) {
        console.warn(`⚠️ Falha ao setFixedUsdPrice(${tokenAddr}):`, e?.reason || e?.message || e);
      }
    }
    console.log('✅ fixedUsdPrice configurado (quando aplicável).');
  } else {
    console.log('ℹ️ Nenhum fixedPrices definido no config. Pulando etapa.');
  }

  // --- Verify (opcional) ---
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
