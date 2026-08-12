'use strict';
const { Worker } = require('worker_threads');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Mnemonic, HDNodeWallet } = require('ethers');

// ============================== CẤU HÌNH ==============================
// Số ký tự giống nhau ở cuối địa chỉ cần tìm.
// Độ khó = 16^(REPEAT_LEN-1) địa chỉ trung bình.  7 => 16.8 triệu | 8 => 268 triệu
const REPEAT_LEN = num(process.env.REPEAT_LEN, 8);

// Số địa chỉ con quét trên MỖI mnemonic.
//   = 1     -> mnemonic mới mỗi vòng, path chuẩn m/44'/60'/0'/0/0,
//              import seed phrase vào MetaMask thấy ngay — nhưng CHẬM ~30x.
//   = 5000  -> nhanh, nhưng ví nằm ở index cao => phải import bằng PRIVATE KEY.
const INDEXES_PER_MNEMONIC = num(process.env.INDEXES_PER_MNEMONIC, 1);

const THREADS = num(process.env.THREADS, os.availableParallelism?.() ?? os.cpus().length);
const OUT_FILE = path.resolve(process.env.OUT || 'wallets.jsonl');
const BASE_PATH = "m/44'/60'/0'/0";
const REPORT_EVERY = 2000;   // worker báo cáo tiến độ sau mỗi N địa chỉ
const STATS_INTERVAL_MS = 5000;
// ======================================================================

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

const EXPECTED = Math.pow(16, REPEAT_LEN - 1); // số địa chỉ trung bình cần thử
const workers = [];
let totalTried = 0;
let totalFound = 0;
let rejected = 0;
let readyCount = 0;
const startedAt = Date.now();

console.log('─'.repeat(64));
console.log(`  Tìm địa chỉ có ${REPEAT_LEN} ký tự cuối giống nhau`);
console.log(`  Luồng           : ${THREADS}`);
console.log(`  Index/mnemonic  : ${INDEXES_PER_MNEMONIC}` +
  (INDEXES_PER_MNEMONIC === 1 ? '  (path chuẩn, chậm)' : '  (nhanh, import bằng private key)'));
console.log(`  Độ khó          : ~${EXPECTED.toLocaleString('en-US')} địa chỉ / 1 ví`);
console.log(`  Lưu vào         : ${OUT_FILE}`);
console.log('─'.repeat(64));

/** Kiểm chứng độc lập bằng ethers: mnemonic + path có thật sự sinh ra address & key này không. */
function verifyFinding(d) {
  try {
    const w = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(d.mnemonic), d.path);
    return w.address === d.address && w.privateKey === d.privateKey;
  } catch {
    return false;
  }
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  if (d) return `${d}n ${h}g`;
  if (h) return `${h}g ${m}p`;
  if (m) return `${m}p ${s}s`;
  return `${s}s`;
}

function spawn(id) {
  const w = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: {
      repeatLen: REPEAT_LEN,
      indexesPerMnemonic: INDEXES_PER_MNEMONIC,
      reportEvery: REPORT_EVERY,
      basePath: BASE_PATH,
    },
  });

  w.on('message', (msg) => {
    if (msg.type === 'count') {
      totalTried += msg.count;
      return;
    }
    if (msg.type === 'ready') {
      if (++readyCount === THREADS) console.log('✅ Tất cả luồng đã qua self-test, bắt đầu đào...\n');
      return;
    }
    if (msg.type === 'found') {
      if (!verifyFinding(msg.data)) {
        rejected++;
        console.error(`⛔ Ví bị TỪ CHỐI (verify thất bại): ${msg.data.address}`);
        return;
      }
      totalFound++;
      // Append-only: process bị kill giữa chừng cũng không hỏng dữ liệu cũ
      fs.appendFileSync(OUT_FILE, JSON.stringify(msg.data) + '\n');
      console.log(`\n🎉 VÍ #${totalFound}  ${msg.data.address}`);
      console.log(`   path: ${msg.data.path}   (đã verify ✅, đã lưu)\n`);
    }
  });

  w.on('error', (err) => {
    console.error(`❌ Luồng ${id} lỗi: ${err.message}`);
    if (!stopping) {
      console.error(`   → khởi động lại luồng ${id} sau 1s`);
      setTimeout(() => { workers[id] = spawn(id); }, 1000);
    }
  });

  return w;
}

for (let i = 0; i < THREADS; i++) workers[i] = spawn(i);

const timer = setInterval(() => {
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = totalTried / elapsed;
  const eta = rate > 0 ? EXPECTED / rate : Infinity;
  const pct = ((totalTried / EXPECTED) * 100).toFixed(1);
  process.stdout.write(
    `\r⛏  ${totalTried.toLocaleString('en-US')} địa chỉ | ` +
    `${Math.round(rate).toLocaleString('en-US')}/s | ` +
    `tìm được ${totalFound}${rejected ? ` (từ chối ${rejected})` : ''} | ` +
    `chu kỳ ~${fmtDuration(eta)} | đã chạy ${fmtDuration(elapsed)} (${pct}%)   `
  );
}, STATS_INTERVAL_MS);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n\n─── Dừng ───`);
  console.log(`Đã thử   : ${totalTried.toLocaleString('en-US')} địa chỉ trong ${fmtDuration(elapsed)}`);
  console.log(`Tốc độ   : ${Math.round(totalTried / elapsed).toLocaleString('en-US')} địa chỉ/giây`);
  console.log(`Tìm được : ${totalFound} ví${totalFound ? ` → ${OUT_FILE}` : ''}`);
  Promise.all(workers.map((w) => w?.terminate())).then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
