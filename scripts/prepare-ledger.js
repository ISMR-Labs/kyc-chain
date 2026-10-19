import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../server/store.js';
import { deriveInstitutionWallets } from '../server/chain.js';

const directory = process.env.DATA_DIR;
const target = process.argv[2];
if (!directory || !target) throw new Error('Set DATA_DIR and provide the ledger configuration output path.');
const { db, keys } = openStore(directory);
try {
  const alloc = Object.fromEntries(deriveInstitutionWallets(keys).map(wallet => [wallet.address.slice(2).toLowerCase(), { balance: '1000000000000000000000' }]));
  const configuration = {
    genesis: { config: { chainId: 202610, berlinBlock: 0, londonBlock: 0, zeroBaseFee: true, qbft: { blockperiodseconds: 2, epochlength: 30000, requesttimeoutseconds: 4 } }, nonce: '0x0', timestamp: '0x58ee40ba', gasLimit: '0x1c9c380', difficulty: '0x1', mixHash: '0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365', coinbase: '0x0000000000000000000000000000000000000000', alloc },
    blockchain: { nodes: { generate: true, count: 1 } }
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(configuration, null, 2), { mode: 0o600, flag: 'wx' });
  console.log('Genesis configuration prepared with public funding addresses. Private keys remain in the vault directory.');
} finally { db.close(); }
