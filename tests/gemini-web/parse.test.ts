import { describe, it, expect } from 'vitest';
import {
  parseGeminiStreamGenerateResponse,
  isGeminiModelUnavailable,
} from '../../src/gemini-web/client.js';

function makeRawResponseWithBody(body: unknown): string {
  const responseJson = [[null, null, JSON.stringify(body)]];
  return `)]}'\n\n${JSON.stringify(responseJson)}`;
}

describe('gemini-web parseGeminiStreamGenerateResponse', () => {
  it('parses text + thoughts from minimal body payload', () => {
    const candidate: unknown[] = [];
    candidate[0] = 'rcid-1';
    candidate[1] = ['Hello'];
    candidate[37] = [['Thinking']];

    const body: unknown[] = [];
    body[1] = ['cid', 'rid', 'rcid-1'];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(makeRawResponseWithBody(body));
    expect(parsed.text).toBe('Hello');
    expect(parsed.thoughts).toBe('Thinking');
    expect(parsed.metadata).toEqual(['cid', 'rid', 'rcid-1']);
  });

  it('extracts model-unavailable error code 1052 from response json', () => {
    const responseJson: unknown[] = [];
    // errorCode path: [0,5,2,0,1,0]
    responseJson[0] = [];
    (responseJson[0] as unknown[])[5] = [];
    ((responseJson[0] as unknown[])[5] as unknown[])[2] = [];
    (((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] = [];
    ((((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] as unknown[])[1] = [];
    (
      (
        (((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] as unknown[]
      )[1] as unknown[]
    )[0] = 1052;

    const raw = `)]}'\n\n${JSON.stringify(responseJson)}`;
    expect(isGeminiModelUnavailable(parseGeminiStreamGenerateResponse(raw).errorCode)).toBe(true);
  });
});
