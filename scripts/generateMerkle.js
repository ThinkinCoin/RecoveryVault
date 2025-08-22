const fs = require('fs');
const path = require('path');
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');

// Caminho do arquivo da lista
const listPath = path.join(__dirname, '..', 'public', 'data', 'prehack_list.txt');
const rootOutput = path.join(__dirname, '..', 'public', 'data', 'merkleRoot.json');
const proofOutput = path.join(__dirname, '..', 'public', 'data', 'proofs.json');

// Leitura da lista
const addresses = fs
  .readFileSync(listPath, 'utf-8')
  .split('\n')
  .map(addr => addr.trim().toLowerCase())
  .filter(Boolean);

// Geração dos leaves
const leaves = addresses.map(addr => keccak256(addr));

// Criação da árvore
const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });

// Geração do root
const root = tree.getHexRoot();

// Salvar o root
fs.writeFileSync(rootOutput, JSON.stringify({ merkleRoot: root }, null, 2));
console.log('✅ Merkle root saved to merkleRoot.json');

// Gerar proofs para cada endereço
const allProofs = {};
addresses.forEach(addr => {
  const proof = tree.getHexProof(keccak256(addr));
  allProofs[addr] = proof;
});

// Salvar os proofs
fs.writeFileSync(proofOutput, JSON.stringify(allProofs, null, 2));
console.log('✅ Proofs saved to proofs.json');

// CLI opcional
if (process.argv[2]) {
  const query = process.argv[2].toLowerCase();
  const proof = tree.getHexProof(keccak256(query));
  console.log(`\n🔍 Proof for ${query}:`);
  console.log(JSON.stringify(proof, null, 2));
}
