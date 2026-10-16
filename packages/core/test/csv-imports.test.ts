import { describe, expect, it } from 'vitest';
import { detectDelimiter, neutralizeCsvCell, parseCsv, toCsv } from '../src/csv';
import { mapImportRow, parseConsent, parseFlexibleDate, parseRelationship, splitFullName, suggestMapping, type ImportTarget } from '../src/imports';

describe('CSV parsing', () => {
  it('parses quoted fields, escaped quotes, CRLF and BOM', () => {
    const text = '\uFEFFname,email,notes\r\n"Mehta, Rahul",rahul@example.com,"said ""hi""\nthen left"\r\nPriya,priya@example.com,\r\n';
    const { rows, delimiter } = parseCsv(text);
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['name', 'email', 'notes'],
      ['Mehta, Rahul', 'rahul@example.com', 'said "hi"\nthen left'],
      ['Priya', 'priya@example.com', ''],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('"a;b",c,d')).toBe(',');
  });

  it('skips blank lines and can stop early', () => {
    const { rows, truncated } = parseCsv('a\n\n1\n2\n3\n', { maxRecords: 2 });
    expect(rows).toEqual([['a'], ['1']]);
    expect(truncated).toBe(true);
  });

  it('writes CSV that round-trips and neutralises formulas', () => {
    const csv = toCsv([
      ['name', 'note'],
      ['A, B', 'line1\nline2'],
      ['=HYPERLINK("x")', '-42'],
    ]);
    expect(parseCsv(csv).rows).toEqual([
      ['name', 'note'],
      ['A, B', 'line1\nline2'],
      [`'=HYPERLINK("x")`, '-42'],
    ]);
    expect(neutralizeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeCsvCell('+91 98765')).toBe("'+91 98765");
  });
});

describe('import mapping', () => {
  it('suggests mappings from common headers', () => {
    expect(suggestMapping(['First Name', 'Surname', 'E-mail Address', 'DOB', 'Organisation', 'Tags', 'Plan', 'Random'], ['plan'])).toEqual([
      'first_name',
      'last_name',
      'email',
      'birthday',
      'company',
      'tags',
      'custom:plan',
      'ignore',
    ]);
  });

  it('does not map two columns to the same field', () => {
    expect(suggestMapping(['Email', 'Mail'])).toEqual(['email', 'ignore']);
  });
});

describe('flexible dates', () => {
  it('parses ISO, textual and vCard dates', () => {
    expect(parseFlexibleDate('1990-03-07')).toEqual({ month: 3, day: 7, year: 1990, ambiguous: false });
    expect(parseFlexibleDate('7 March 1990')).toEqual({ month: 3, day: 7, year: 1990, ambiguous: false });
    expect(parseFlexibleDate('March 7th')).toEqual({ month: 3, day: 7, year: null, ambiguous: false });
    expect(parseFlexibleDate('Mar 7, 1990')).toEqual({ month: 3, day: 7, year: 1990, ambiguous: false });
    expect(parseFlexibleDate('--03-07')).toEqual({ month: 3, day: 7, year: null, ambiguous: false });
  });

  it('uses the date order for ambiguous numeric dates and flags them', () => {
    expect(parseFlexibleDate('07/03/1990', 'DMY')).toEqual({ month: 3, day: 7, year: 1990, ambiguous: true });
    expect(parseFlexibleDate('07/03/1990', 'MDY')).toEqual({ month: 7, day: 3, year: 1990, ambiguous: true });
    expect(parseFlexibleDate('25/12', 'MDY')).toEqual({ month: 12, day: 25, year: null, ambiguous: false });
    expect(parseFlexibleDate('05/05/90')).toEqual({ month: 5, day: 5, year: 1990, ambiguous: false });
  });

  it('rejects impossible dates', () => {
    expect(parseFlexibleDate('1990-02-29')).toBeNull();
    expect(parseFlexibleDate('31/04/2020')).toBeNull();
    expect(parseFlexibleDate('29 Feb')).toEqual({ month: 2, day: 29, year: null, ambiguous: false });
    expect(parseFlexibleDate('soon')).toBeNull();
  });
});

describe('value parsing', () => {
  it('maps consent synonyms', () => {
    expect(parseConsent('Yes')).toBe('granted');
    expect(parseConsent('opted-in')).toBe('granted');
    expect(parseConsent('Unsubscribed')).toBe('withdrawn');
    expect(parseConsent('implied')).toBe('implied');
    expect(parseConsent('maybe')).toBeNull();
  });

  it('maps relationship synonyms', () => {
    expect(parseRelationship('Customer')).toBe('client');
    expect(parseRelationship('prospect')).toBe('lead');
    expect(parseRelationship('alien')).toBeNull();
  });

  it('splits full names', () => {
    expect(splitFullName('Rahul Mehta')).toEqual({ firstName: 'Rahul', lastName: 'Mehta' });
    expect(splitFullName('Mehta, Rahul')).toEqual({ firstName: 'Rahul', lastName: 'Mehta' });
    expect(splitFullName('Madonna')).toEqual({ firstName: 'Madonna', lastName: null });
    expect(splitFullName('Ana María López')).toEqual({ firstName: 'Ana María', lastName: 'López' });
  });
});

describe('mapImportRow', () => {
  const mapping: ImportTarget[] = ['full_name', 'email', 'birthday', 'tags', 'consent_status', 'custom:plan', 'timezone'];
  const options = { dateOrder: 'DMY' as const, customFields: [{ key: 'plan', type: 'select' as const, options: ['Free', 'Pro'] }] };

  it('builds a clean record', () => {
    const { record, errors, warnings } = mapImportRow(
      ['Rahul Mehta', 'Rahul@Example.com', '7 March', 'vip; client , vip', 'yes', 'pro', 'Asia/Kolkata'],
      mapping,
      options,
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(record).toMatchObject({
      firstName: 'Rahul',
      lastName: 'Mehta',
      email: 'rahul@example.com',
      birthday: { month: 3, day: 7, year: null },
      tags: ['vip', 'client'],
      consentStatus: 'granted',
      customFields: { plan: 'Pro' },
      timezone: 'Asia/Kolkata',
    });
  });

  it('collects errors without throwing', () => {
    const { errors, warnings } = mapImportRow(['', 'not-an-email', '31/02', '', 'perhaps', 'Enterprise', 'Mars/Base'], mapping, options);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Invalid e-mail/),
        expect.stringMatching(/Unrecognised birthday/),
        expect.stringMatching(/consent/),
        expect.stringMatching(/plan/),
        expect.stringMatching(/no e-mail address or name/),
      ]),
    );
    expect(warnings).toEqual([expect.stringMatching(/time zone/)]);
  });

  it('combines separate birthday month, day and year columns', () => {
    const { record, errors } = mapImportRow(['Priya', '2', '29', '1996'], ['first_name', 'birthday_month', 'birthday_day', 'birth_year'], options);
    expect(errors).toEqual([]);
    expect(record.birthday).toEqual({ month: 2, day: 29, year: 1996 });
  });

  it('drops an impossible birth year for 29 February instead of rejecting the birthday', () => {
    const { record } = mapImportRow(['Priya', '2', '29', '1997'], ['first_name', 'birthday_month', 'birthday_day', 'birth_year'], options);
    expect(record.birthday).toEqual({ month: 2, day: 29, year: null });
  });
});
