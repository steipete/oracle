class MockStream {
  constructor(response) {
    this.response = response;
    this.sent = false;
  }
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        if (this.sent) return { done: true, value: undefined };
        this.sent = true;
        return {
          done: false,
          value: {
            type: 'response.output_text.delta',
            response_id: this.response.id,
            output_index: 0,
            item_index: 0,
            delta: this.response.output_text?.[0] ?? 'Mock answer text.',
          },
        };
      },
    };
  }
  async finalResponse() {
    return this.response;
  }
  abort() {}
}

function makeResponse(body) {
  const text = `Echo(${body.model ?? 'unknown'}): ${body.input?.[0]?.content?.[0]?.text ?? ''}`;
  return {
    id: `mock-${body.model ?? 'id'}`,
    status: 'completed',
    usage: {
      input_tokens: 12,
      output_tokens: 8,
      reasoning_tokens: 0,
      total_tokens: 20,
    },
    output_text: [text],
    output: [{ type: 'text', text }],
    _request_id: 'mock-req',
  };
}

function mockClientFactory() {
  return {
    responses: {
      stream: async (body) => new MockStream(makeResponse(body)),
      create: async (body) => makeResponse(body),
      retrieve: async () => makeResponse({}),
    },
  };
}

module.exports = mockClientFactory;
module.exports.default = mockClientFactory;
