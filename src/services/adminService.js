// src/services/adminService.js
import { Contract, parseUnits } from "ethers";
import { getWriteContract, getReadContract  } from "@/services/vaultCore";

// --- ABI mínimo p/ oracles que expõem latestPrice() (int256,uint8) ---
const IORACLE_ABI = [
  {
    inputs: [],
    name: "latestPrice",
    outputs: [
      { internalType: "int256", name: "price", decimals: undefined, type: "int256" },
      { internalType: "uint8",  name: "decimals", type: "uint8" }
    ],
    stateMutability: "view",
    type: "function"
  }
];

// ---------- helpers ----------
const b = (v) => {
  try { return BigInt(v ?? 0n); } catch { return 0n; }
};

function sameAddr(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function readVaultBalances(contractLike) {
  try {
    const res = await contractLike.getVaultBalances();
    // Pode vir como tupla [w,u] ou objeto { woneBalance, usdcBalance }
    if (Array.isArray(res)) return { w: b(res[0]), u: b(res[1]) };
    if (res && typeof res === "object") {
      return { w: b(res.woneBalance), u: b(res.usdcBalance) };
    }
  } catch { /* ignore */ }
  return { w: 0n, u: 0n };
}

function prettyRevert(e, fallback) {
  const msg =
    e?.reason ||
    e?.shortMessage ||
    e?.error?.message ||
    e?.info?.error?.message ||
    e?.data?.message ||
    e?.message ||
    fallback ||
    "Transaction failed";
  if (/Exceeds daily limit/i.test(msg)) return "Daily limit exceeded (USD×1e4). Try a smaller amount.";
  if (/Invalid oracle/i.test(msg)) return "Invalid Oracle  (latestPrice <= 0 or ABI dont match).";
  if (/No funds/i.test(msg)) return "Vault empty (wONE/USDC).";
  if (/Round ID must increase/i.test(msg)) return "Round ID need be higher than active.";
  if (/caller is not the owner/i.test(msg)) return "You´re not owner, fonzie!.";
  if (/missing revert data/i.test(msg)) return "Reverted by contract (unknown).";
  if (/Round not initialized/i.test(msg)) return "Round not started.";
  if (/Unsupported valuation/i.test(msg)) return "Not supported valuation Token (adjust oracle/ Fixed Price).";

  return msg;
}

async function preflightOracle(provider, oracleAddr) {
  if (!oracleAddr || oracleAddr === "0x0000000000000000000000000000000000000000") {
    throw new Error("Oracle not configured in Vault");
  }
  const o = new Contract(oracleAddr, IORACLE_ABI, provider);
  let price, dec;
  try {
    const r = await o.latestPrice();
    // ethers v6: pode vir tuple ou objeto
    price = r?.price ?? (Array.isArray(r) ? r[0] : r);
    dec   = r?.decimals ?? (Array.isArray(r) ? r[1] : undefined);
  } catch {
    throw new Error("Oracle call failed (check ABI)");
  }
  const p = b(price);
  if (p <= 0n) throw new Error("Invalid oracle");
  return { price: p, decimals: Number(dec ?? 18) };
}

// Simula a chamada on-chain para capturar reverts sem gastar gas.
// Usa provider.call com o `from` do signer, para satisfazer onlyOwner.
async function simulateStartNewRound(contract, signer, nextRound) {
  try {
    const addr = await signer.getAddress();
    const data = contract.interface.encodeFunctionData("startNewRound", [ nextRound ]);
    const txReq = {
      from: addr,
      to: contract.target,         // ethers v6
      data
    };
    await signer.provider.call(txReq);
    // Se não reverteu, está OK
  } catch (e) {
    // Decodifica razão se possível
    throw new Error(prettyRevert(e, "Simulation failed"));
  }
}

// -------- Admin API --------
export async function setDailyLimit(signer, amountLike){
  if (!signer) throw new Error("Signer indisponible (presumably not logged in)");
  const v = getWriteContract(signer);
  // O contrato espera USD * 1e18. Aceitamos bigint já em 1e18
  // ou string/number que converteremos com 18 casas.
  let usd18;
  if (typeof amountLike === "bigint") {
    usd18 = amountLike;
  } else {
    const s = String(amountLike ?? "").trim().replace(",", ".");
    if (!s || !/^\d*(\.\d*)?$/.test(s)) throw new Error("Invalid amount");
    usd18 = BigInt(parseUnits(s, 18));
  }
  const tx = await v.setDailyLimit(usd18);
  return await tx.wait();
}

export async function setDevWallet(signer, wallet){
  const v = getWriteContract(signer);
  const tx = await v.setDevWallet(wallet);
  return await tx.wait();
}

export async function setFeeTiers(signer, thresholds, bpsArr){
  const v = getWriteContract(signer);
  const tx = await v.setFeeTiers(thresholds, bpsArr);
  return await tx.wait();
}

export async function setFixedUsdPrice(signer, token, usdPrice18){
  const v = getWriteContract(signer);
  const tx = await v.setFixedUsdPrice(token, usdPrice18);
  return await tx.wait();
}

export async function setLocked(signer, status) {
  if (!signer) throw new Error("Signer  indisponible (presumably not logged in)");
  const c = getWriteContract(signer);
  try {
    return await c.setLocked(Boolean(status));
  } catch (e) {
    throw new Error(prettyRevert(e, "Failed to change lock status"));
  }
}

export async function setMerkleRoot(signer, root){
  const v = getWriteContract(signer);
  const tx = await v.setMerkleRoot(root);
  return await tx.wait();
}

export async function setOracle(signer, addr){
  const v = getWriteContract(signer);
  const tx = await v.setOracle(addr);
  return await tx.wait();
}

export async function setRmcWallet(signer, wallet){
  const v = getWriteContract(signer);
  const tx = await v.setRmcWallet(wallet);
  return await tx.wait();
}

export async function setSupportedToken(signer, token, allowed){
  const v = getWriteContract(signer);
  const tx = await v.setSupportedToken(token, allowed);
  return await tx.wait();
}

export async function startNewRound(signer, roundId) {
  if (!signer) throw new Error("Signer indisponible (presumably not logged in)");

  const c = getWriteContract(signer);
  const provider = signer.provider;
  if (!provider) throw new Error("Provider not available from signer");

  // 0) opcional: confirma owner
  try {
    const [owner, me] = await Promise.all([c.owner(), signer.getAddress()]);
    if (!sameAddr(owner, me)) {
      throw new Error(`Account is not owner.\nOwner: ${owner}\nYou:  ${me}`);
    }
  } catch {
    // se falhar a leitura, seguimos (onlyOwner vai proteger)
  }

  // 1) Ler estado atual
  const [currentRound, balances, oracleAddr] = await Promise.all([
    c.currentRound().catch(() => 0n),
    readVaultBalances(c),
    c.oracle().catch(() => null),
  ]);

  const curr = b(currentRound);
  const next = b(roundId);

  // 2) Validar roundId > currentRound
  if (next <= curr) {
    throw new Error(`Round ID should be higher than active.  (${curr}). Sugest: ${curr + 1n}`);
  }

  // 3) Validar liquidez do cofre (wONE/USDC)
  const { w, u } = balances;
  if (w === 0n && u === 0n) {
    throw new Error("Cofre sem liquidez (wONE/USDC). Deposite fundos antes de iniciar um novo round.");
  }

  // 4) Pré-checar oracle (contrato exige latestPrice() > 0)
  await preflightOracle(provider, oracleAddr);

  // 5) (Opcional, seguro) Simular chamada para capturar revert antes do envio
  //    Evita dependência de c.estimateGas.* que pode não existir em alguns runners.
  await simulateStartNewRound(c, signer, next);

  // 6) Enviar tx
  try {
    // Se a sua ABI estiver desatualizada e não tiver startNewRound,
    // isso geraria "c.startNewRound is not a function". Atualize a ABI do Vault.
    const tx = await c.startNewRound(next);
    return tx; // o caller decide aguardar o receipt
  } catch (e) {
    throw new Error(prettyRevert(e, "Falha ao iniciar novo round"));
  }
}

export async function suggestNextRoundId(providerOrSigner) {
  const c = providerOrSigner && providerOrSigner.provider
    ? await getReadContract(providerOrSigner.provider)
    : await getReadContract(providerOrSigner);
  const curr = await c.currentRound();
  return (BigInt(curr ?? 0n) + 1n).toString();
}

export async function setRoundDelayEnabled(signer, enabled) {
  if (!signer) throw new Error("Signer não disponível");
  const c = getWriteContract(signer);
  if (typeof c.setRoundDelayEnabled !== "function") {
    throw new Error("Contract method setRoundDelayEnabled not available");
  }
  // manter sem wait(), como setLocked
  return c.setRoundDelayEnabled(Boolean(enabled));
}

export async function transferOwnership(signer, newOwner){
  const v = getWriteContract(signer);
  const tx = await v.transferOwnership(newOwner);
  return await tx.wait();
}

export async function renounceOwnership(signer){
  const v = getWriteContract(signer);
  const tx = await v.renounceOwnership();
  return await tx.wait();
}

export async function withdrawFunds(signer, token){
  const v = getWriteContract(signer);
  const tx = await v.withdrawFunds(token);
  return await tx.wait();
}
