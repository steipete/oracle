class MockStream {
  constructor(response) {
    this.response = response;
    this.sent = false;
  }

  [Symbol.asyncIterator]() {
    const events = [
      {
        type: 'response.output_text.delta',
        response_id: this.response.id,
        output_index: 0,
        item_index: 0,
        delta: 'Mock answer text.',
      },
    ];
    let index = 0;
    return {
      next: async () => {
        if (index >= events.length) {
          return { done: true, value: undefined };
        }
        const value = events[index];
        index += 1;
        return { done: false, value };
      },
    };
  }

  async finalResponse() {
    return this.response;
  }

  abort() {}
}

let responseCounter = 0;

function mockClientFactory() {
  return {
    responses: {
      stream: async (body) => {
        if (process.env.ORACLE_TEST_REQUIRE_PREV === '1' && !body.previous_response_id) {
          throw new Error('MISSING_PREVIOUS_RESPONSE_ID');
        }
        responseCounter += 1;
        const response = {
          id: `resp_mock${Date.now()}${responseCounter}`,
          status: 'completed',
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            reasoning_tokens: 0,
            total_tokens: 20,
          },
          output: [
            {
              type: 'message',
              content: [{ type: 'text', text: `Echo: ${body.input?.[0]?.content?.[0]?.text ?? ''}` }],
            },
          ],
          _request_id: 'mock-req',
        };
        return new MockStream(response);
      },
      create: async () => {
        throw new Error('Background mode not supported in mock client');
      },
      retrieve: async () => {
        throw new Error('Retrieve not supported in mock client');
      },
    },
  };
}

module.exports = mockClientFactory;
module.exports.default = mockClientFactory;
