import { describe, expect, it } from 'vitest';
import {
  BACKUP_NAME_VARIABLES,
  DEFAULT_BACKUP_NAME_TEMPLATE,
  MAX_TEMPLATE_LENGTH,
  counterSuffix,
  exampleValues,
  renderBackupName,
  sanitizeNameValue,
  templateIsUnique,
  timeValues,
  validateBackupNameTemplate,
} from '../../../src/utils/backup-name.js';

describe('backup file name templates', () => {
  it('renders the default as every backup was named before templates', () => {
    const when = new Date('2026-11-11T13:42:09.517Z');
    const before = when.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    expect(renderBackupName(DEFAULT_BACKUP_NAME_TEMPLATE, timeValues(when))).toBe(
      `cidrella-backup-${before}`,
    );
  });

  it('renders every variable', () => {
    const template = BACKUP_NAME_VARIABLES.map((v) => `{{${v.key}}}`).join('_');
    expect(validateBackupNameTemplate(template)).toBeNull();
    expect(renderBackupName(template, exampleValues())).toBe(
      'cidrella_0.6.4_94_dnsmasq_manual_2026-11-11_13-42-09',
    );
  });

  it('makes a value safe for a file name', () => {
    expect(renderBackupName('{{hostname}}', { hostname: 'a/b c"d..e' })).toBe('a-b-c-d..e');
    expect(sanitizeNameValue(undefined)).toBe('');
    expect(sanitizeNameValue(94)).toBe('94');
  });

  it.each([
    ['', 'Enter a file name'],
    ['   ', 'Enter a file name'],
    ['x'.repeat(MAX_TEMPLATE_LENGTH + 1), 'characters or fewer'],
    ['backups/{{date}}', 'no spaces or slashes'],
    ['../{{date}}', 'no spaces or slashes'],
    ['my backup', 'no spaces or slashes'],
    ['a"b', 'no spaces or slashes'],
    ['{{host}}', 'Unknown variable {{host}}'],
    ['{{date}', 'two braces'],
    ['{date}}', 'two braces'],
    ['.{{date}}', 'cannot start with a dot'],
    ['{{date}}.tar.gz', 'it is added for you'],
    [null, 'Enter a file name'],
  ])('refuses %j', (template, message) => {
    expect(validateBackupNameTemplate(template)).toContain(message);
  });

  it('accepts the default and plain text', () => {
    expect(validateBackupNameTemplate(DEFAULT_BACKUP_NAME_TEMPLATE)).toBeNull();
    expect(validateBackupNameTemplate('nightly')).toBeNull();
    expect(validateBackupNameTemplate('x'.repeat(MAX_TEMPLATE_LENGTH))).toBeNull();
  });

  it('calls a template unique only with both the date and the time', () => {
    expect(templateIsUnique(DEFAULT_BACKUP_NAME_TEMPLATE)).toBe(true);
    expect(templateIsUnique('{{hostname}}-{{time}}')).toBe(false);
    expect(templateIsUnique('{{hostname}}-{{date}}')).toBe(false);
    expect(templateIsUnique('{{hostname}}')).toBe(false);
  });

  it('counts -00 to -FF', () => {
    expect(counterSuffix(0)).toBe('-00');
    expect(counterSuffix(10)).toBe('-0A');
    expect(counterSuffix(255)).toBe('-FF');
  });
});
