import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserProvider, JsonRpcProvider, FetchRequest, Contract, ContractFactory, Wallet, HDNodeWallet, keccak256 } from 'ethers';

export async function compile() {
  const { default: solc } = await import('solc');
  const source = fs.readFileSync(fileURLToPath(new URL('../contracts/KYCRegistry.sol', import.meta.url)), 'utf8');
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'KYCRegistry.sol': { content: source } }, settings: { evmVersion: 'london', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errors = (result.errors || []).filter(x => x.severity === 'error');
  if (errors.length) throw new Error(errors.map(x => x.formattedMessage).join('\n'));
  return result.contracts['KYCRegistry.sol'].KYCRegistry;
}

export function deriveInstitutionWallets(keys, provider) {
  const root = HDNodeWallet.fromSeed(Buffer.from(keys.chainSeed, 'hex'));
  return Array.from({ length: 20 }, (_, i) => root.derivePath(`m/44'/60'/0'/0/${i}`).connect(provider || null));
}

export async function openChain(directory, keys, db) {
  const rpcUrl = process.env.RPC_URL;
  let engine, provider, wallets;
  if (rpcUrl) {
    const connection = new FetchRequest(rpcUrl);
    connection.timeout = 10000;
    provider = new JsonRpcProvider(connection, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    provider.pollingInterval = 1000;
    const network = await provider.getNetwork();
    if (network.chainId !== 202610n) throw new Error('Unexpected ledger chain ID. Refusing to sign transactions.');
    wallets = deriveInstitutionWallets(keys, provider);
  } else {
    const { default: ganache } = await import('ganache');
    engine = ganache.provider({ logging: { quiet: true }, database: { dbPath: path.join(directory, 'chain') }, chain: { chainId: 202610, hardfork: 'shanghai' }, wallet: { seed: keys.chainSeed, totalAccounts: 20, defaultBalance: 1000 } });
    provider = new BrowserProvider(engine, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 50;
    wallets = Object.values(engine.getInitialAccounts()).map(value => new Wallet(value.secretKey, provider));
  }
  const artifact = fileURLToPath(new URL('../artifacts/KYCRegistry.json', import.meta.url));
  const compiled = rpcUrl ? JSON.parse(fs.readFileSync(artifact, 'utf8')) : await compile();
  const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get('contract');
  let contract;
  if (saved) {
    contract = new Contract(saved.value, compiled.abi, wallets[0]);
    if (await provider.getCode(saved.value) === '0x') throw new Error('Persisted chain is missing its registry. Restore the complete data directory.');
  } else {
    contract = await new ContractFactory(compiled.abi, compiled.evm.bytecode.object, wallets[0]).deploy();
    await contract.waitForDeployment();
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('contract', await contract.getAddress());
  }
  let blocked = false;
  function commit(op) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const q of JSON.parse(op.queries)) db.prepare(q.sql).run(...q.params.map(x => x === '$TX' ? op.hash : x === '$BLOCK' ? op.block : x));
      db.prepare('UPDATE outbox SET state = ?, block = ? WHERE hash = ?').run('committed', op.block, op.hash);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function settle(op) {
    let receipt = await provider.getTransactionReceipt(op.hash);
    if (!receipt) {
      const transaction = await provider.broadcastTransaction(op.raw);
      receipt = await transaction.wait();
    }
    if (receipt.status !== 1) {
      db.prepare('UPDATE outbox SET state = ? WHERE hash = ?').run('failed', op.hash);
      throw new Error('Blockchain transaction reverted');
    }
    commit({ ...op, block: receipt.blockNumber });
    return { tx: op.hash, block: receipt.blockNumber };
  }
  for (const op of db.prepare("SELECT * FROM outbox WHERE state = 'prepared' ORDER BY rowid").all()) await settle(op);

  return {
    engine, provider, wallets, contract, mode: rpcUrl ? 'Besu QBFT private ledger' : 'Local development ledger',
    async transact(slot, method, args, queries) {
      if (blocked) throw new Error('A transaction needs recovery. Restart the application to reconcile its durable outbox.');
      const wallet = wallets[slot];
      const request = await contract.connect(wallet)[method].populateTransaction(...args);
      const populated = await wallet.populateTransaction(request);
      const raw = await wallet.signTransaction(populated);
      const txHash = keccak256(raw);
      const op = { hash: txHash, raw, queries: JSON.stringify(queries), state: 'prepared' };
      db.prepare('INSERT INTO outbox(hash,raw,queries,state) VALUES (?,?,?,?)').run(op.hash, op.raw, op.queries, op.state);
      try { return await settle(op); } catch (error) { blocked = true; throw error; }
    },
    async close() { provider.destroy(); if (engine) await engine.disconnect(); }
  };
}
