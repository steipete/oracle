import puppeteer from 'puppeteer-core';

const port = parseInt(process.argv[2] || '52990', 10);

async function main() {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });
  
  const pages = await browser.pages();
  let targetPage = null;
  
  for (const page of pages) {
    const url = page.url();
    if (url.includes('chatgpt.com/c/')) {
      targetPage = page;
      break;
    }
  }
  
  if (!targetPage) {
    console.error('ChatGPT conversation page not found');
    process.exit(1);
  }
  
  console.error('Found page:', await targetPage.url());
  
  // Extract the last assistant message
  const content = await targetPage.evaluate(() => {
    // Try multiple selectors for ChatGPT's assistant messages
    const selectors = [
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]',
      '.agent-turn .markdown',
      '.agent-turn',
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        const lastEl = elements[elements.length - 1] as HTMLElement;
        return { 
          selector, 
          count: elements.length,
          text: lastEl.innerText 
        };
      }
    }
    
    // Debug: show what's on the page
    const body = document.body.innerHTML;
    return { error: 'No messages found', bodyLength: body.length, sample: body.slice(0, 2000) };
  });
  
  if ((content as any).error) {
    console.error('Error:', JSON.stringify(content, null, 2));
    process.exit(1);
  }
  
  console.log((content as any).text);
  browser.disconnect();
}

main().catch(console.error);
