// Official CLI discovery only: no auth, tokens, settings, shell or inference.
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export async function resolveAgyBin() {
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const candidates = (process.env.PATH || '').split(delimiter).filter(isAbsolute).map(dir => join(dir, name));
  candidates.push(join(homedir(), '.gemini', 'antigravity-cli', 'bin', name), join(homedir(), '.local', 'bin', name));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'agy', name), join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', name));
  } else candidates.push(join('/usr/local/bin', name), join('/usr/bin', name));
  for (const candidate of candidates) {
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; }
    catch { /* absent or inaccessible candidates do not authorize fallback execution */ }
  }
  throw Object.assign(new Error('BACKEND_FAILED'), { code: 'BACKEND_FAILED' });
}
