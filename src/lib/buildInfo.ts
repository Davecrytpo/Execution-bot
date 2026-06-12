import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readTrimmedFile(path: string) {
  if (!existsSync(path)) {
    return null;
  }

  const value = readFileSync(path, 'utf8').trim();
  return value || null;
}

function readGitHead(repoRoot: string) {
  const headPath = join(repoRoot, '.git', 'HEAD');
  const head = readTrimmedFile(headPath);
  if (!head) {
    return null;
  }

  if (!head.startsWith('ref: ')) {
    return head;
  }

  const ref = head.slice('ref: '.length).trim();
  const refPath = join(repoRoot, '.git', ...ref.split('/'));
  if (existsSync(refPath)) {
    const refSha = readFileSync(refPath, 'utf8').trim();
    if (refSha) {
      return refSha;
    }
  }

  const packedRefsPath = join(repoRoot, '.git', 'packed-refs');
  if (existsSync(packedRefsPath)) {
    const packedRefs = readFileSync(packedRefsPath, 'utf8').split('\n');
    for (const line of packedRefs) {
      if (!line || line.startsWith('#') || line.startsWith('^')) {
        continue;
      }
      const [sha, packedRef] = line.trim().split(' ');
      if (packedRef === ref && sha) {
        return sha;
      }
    }
  }

  return null;
}

export function getBuildInfo() {
  const repoRoot = process.cwd();
  const revision = process.env.APP_BUILD_REVISION
    ?? readTrimmedFile(join(repoRoot, '.build-revision'))
    ?? readGitHead(repoRoot)
    ?? 'unknown';

  return {
    revision,
    version: process.env.npm_package_version ?? '1.0.0'
  };
}
