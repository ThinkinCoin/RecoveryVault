const fs = require('fs');
const path = require('path');
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256'); // pacote
// Se preferir ethers v6, veja Opção 2 acima

const listPath   = path.join(__dirname, '..', 'public', 'data', 'prehack_list.txt');
const proofsPath = path.join(__dirname, '..', 'public', 'data', 'proofs.json');

const raw = fs.readFileSync(listPath, 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean);

// normaliza, remove duplicatas e comentários
const addresses = Array.from(new Set(
  raw.filter(line => !line.startsWith('#')).map(a => a.toLowerCase())
));

function leafFromAddress(addr) {
  const hex = addr.replace(/^0x/, '');
  return keccak256(Buffer.from(hex, 'hex')); // == keccak256(abi.encodePacked(address))
}

const leaves = addresses.map(leafFromAddress);
const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
const root = tree.getHexRoot();

const proofsObj = {};
for (const addr of addresses) {
  const proof = tree.getHexProof(leafFromAddress(addr));
  proofsObj[addr] = proof;
}

const out = {
  merkleRoot: root,
  format: "keccak256(abi.encodePacked(address))",
  treeOptions: { sortPairs: true },
  proofs: proofsObj,
};

fs.writeFileSync(proofsPath, JSON.stringify(out, null, 2));
console.log('✅ proofs.json salvo com merkleRoot e proofs.');
