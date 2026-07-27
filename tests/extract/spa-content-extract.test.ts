import { describe, expect, test } from 'vitest';
import { extractInlineScriptContent, shouldRecoverFromScripts } from '@/extract/spa-content-extract';

describe('extractInlineScriptContent', () => {
  test('recovers content strings from an inline-script data model (the Duda/SPA case)', () => {
    const html = `<html><body><div id="root"></div>
      <script>window.__DATA__ = {"a":"FreeFall Bluegrass Festival","b":"October 9-11, 2026","c":"3-Day General Admission - $110"};</script>
    </body></html>`;
    const text = extractInlineScriptContent(html);
    expect(text).toContain('FreeFall Bluegrass Festival');
    expect(text).toContain('October 9-11, 2026');
    expect(text).toContain('3-Day General Admission - $110');
  });

  test('decodes escaped strings', () => {
    const html = '<script>var x = "Gates open at 2:00pm\\nMusic at 2:30pm";</script>';
    expect(extractInlineScriptContent(html)).toContain('Gates open at 2:00pm Music at 2:30pm');
  });

  test('drops code-ish and machine tokens', () => {
    const html = '<script>var f = function(){ return "https://x.com/api/v2"; }; var k = "aGVsbG8gd29ybGQgYmFzZTY0";</script>';
    const text = extractInlineScriptContent(html);
    expect(text).not.toContain('https://x.com');
    expect(text).not.toContain('function');
  });

  test('empty when no content-like strings exist', () => {
    expect(extractInlineScriptContent('<script>var a=1;var b=2;</script>')).toBe('');
    expect(extractInlineScriptContent('<html><body>hi</body></html>')).toBe('');
  });

  test('shouldRecoverFromScripts: thin body yes, rich body no', () => {
    expect(shouldRecoverFromScripts('   ')).toBe(true);
    expect(shouldRecoverFromScripts('short')).toBe(true);
    expect(shouldRecoverFromScripts('word '.repeat(200))).toBe(false);
  });
});
