/**
 * Where a command would run from: `name` itself when it holds a slash, else
 * the first PATH directory with an executable of that name, as a shell
 * looks. Null when there is none.
 */
import fs from 'fs';
import path from 'path';

export function findExecutable(name, { envPath = process.env.PATH || '' } = {}) {
  const candidates = name.includes('/')
    ? [name]
    : envPath
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, name));
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not here */
    }
  }
  return null;
}
