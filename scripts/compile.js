import fs from 'node:fs';
import { compile } from '../server/chain.js';
const artifact = await compile();
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/KYCRegistry.json', JSON.stringify(artifact, null, 2));
console.log('Solidity compilation passed. Artifact: artifacts/KYCRegistry.json');
