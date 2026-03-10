import fs from 'fs';
import path from 'path';

const pkg = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf-8')
);

export const APP_VERSION = pkg.version;
