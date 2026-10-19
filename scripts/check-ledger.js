// Integration check using a separate validation contract; never changes the live registry.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JsonRpcProvider, ContractFactory, ZeroHash, id, randomBytes, hexlify } from 'ethers';
import { deriveInstitutionWallets } from '../server/chain.js';

const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
provider.pollingInterval = 500;
try {
  assert.equal((await provider.getNetwork()).chainId, 202610n);
  const keys = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'keys.json')));
  const wallets = deriveInstitutionWallets(keys, provider);
  const artifact = JSON.parse(fs.readFileSync(new URL('../artifacts/KYCRegistry.json', import.meta.url)));
  const registry = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, wallets[0]).deploy();
  await registry.waitForDeployment();
  for (const wallet of wallets.slice(1,3)) await (await registry.addMember(wallet.address)).wait();
  const subject = hexlify(randomBytes(32));
  await (await registry.connect(wallets[1]).anchor(subject, id('validation-pending'), ZeroHash, 0, 0)).wait();
  await (await registry.connect(wallets[1]).anchor(subject, id('validation-verified'), id('validation-pending'), 1, 1)).wait();
  await assert.rejects(registry.connect(wallets[2]).reuse.staticCall(subject, 2));
  await (await registry.connect(wallets[1]).recordConsent(subject, wallets[2].address, 2, true, Math.floor(Date.now()/1000)+3600)).wait();
  const receipt = await (await registry.connect(wallets[2]).reuse(subject, 2)).wait();
  assert.equal(receipt.status, 1);
  await assert.rejects(registry.connect(wallets[2]).anchor.staticCall(subject, id('unauthorized'), id('validation-verified'), 2, 0));
  await (await registry.connect(wallets[1]).anchor(subject, id('validation-update'), id('validation-verified'), 2, 0)).wait();
  await assert.rejects(registry.connect(wallets[2]).reuse.staticCall(subject, 2));
  console.log('Besu integration passed: deploy, membership, append, verify, consent, reuse, unauthorized-write rejection and stale-reuse rejection. Live registry unchanged.');
} finally { provider.destroy(); }
