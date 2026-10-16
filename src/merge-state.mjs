import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const plain = obj => !!obj && typeof obj === 'object' && !Array.isArray(obj);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge the bot's updated state with state already pushed to GitHub.
 * A "create-only" reservation creates a remote commit while the bot is
 * executing. Git rebase would conflict on publications.json; this three-way
 * merge avoids lost message IDs and preserves independent state additions.
 *
 * When both versions alter the same scalar, the latest REMOTE value wins.
 * Unrelated per-key changes (events, announcements, outage notices, etc.)
 * are retained from each branch.
 */
export function mergeState(base, local, remote) {
  if (equal(local,base)) return remote;
  if (equal(remote,base)) return local;
  if (equal(local,remote)) return local;
  if (plain(local) && plain(remote)) {
    const result = {};
    const b=plain(base)?base:{};
    const keys = new Set([...Object.keys(b),...Object.keys(local),...Object.keys(remote)]);
    for (const key of keys) {
      const merged = mergeState(b[key], local[key], remote[key]);
      if (merged !== undefined) result[key]=merged;
    }
    return result;
  }
  // A deletion on one branch and an update on the other must not
  // resurrect stale state. Prefer the latest remote if both changed.
  return remote;
}

async function parseFile(file, fallback={publications:{}}) {
  try { return JSON.parse(await fs.readFile(file,'utf8')); }
  catch (error) {
    if (error.code==='ENOENT') return fallback;
    throw error;
  }
}

async function main() {
  const [basePath, localPath, remotePath]=process.argv.slice(2);
  if(!basePath||!localPath||!remotePath) {
    throw new Error('Usage: node src/merge-state.mjs BASE LOCAL REMOTE_OUTPUT');
  }
  const base=await parseFile(basePath);
  const local=await parseFile(localPath);
  const remote=await parseFile(remotePath);
  const merged=mergeState(base,local,remote);
  await fs.writeFile(remotePath, JSON.stringify(merged,null,2)+'\n');
  console.log('GitHub publication state safely merged with the latest main branch.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}
