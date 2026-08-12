'use strict';
// Chạy: node verify.js [file]   — kiểm tra lại mọi ví đã lưu bằng ethers.
const fs = require('fs');
const { Mnemonic, HDNodeWallet, Wallet } = require('ethers');

const file = process.argv[2] || 'wallets.jsonl';
if (!fs.existsSync(file)) {
  console.error(`Không tìm thấy ${file}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
let ok = 0, bad = 0;

for (const [i, line] of lines.entries()) {
  let d;
  try { d = JSON.parse(line); }
  catch { console.log(`❌ dòng ${i + 1}: JSON hỏng`); bad++; continue; }

  const fromMnemonic = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(d.mnemonic), d.path);
  const fromPrivKey = new Wallet(d.privateKey);

  const pass =
    fromMnemonic.address === d.address &&
    fromMnemonic.privateKey === d.privateKey &&
    fromPrivKey.address === d.address;

  console.log(`${pass ? '✅' : '❌'} ${d.address}  ${d.path}`);
  pass ? ok++ : bad++;
}

console.log(`\nHợp lệ: ${ok} | Sai: ${bad} | Tổng: ${lines.length}`);
process.exit(bad ? 1 : 0);
