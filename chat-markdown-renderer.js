import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import DOMPurify from 'dompurify';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeKatex, { throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' })
  .use(rehypeStringify);

function normalizeMathDelimiters(source) {
  const code = [];
  let result = source.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$|(`+)[^\n]*?\2(?!`)/gm,
    (part) => {
      const token = `CHATMARKDOWNCODE${code.length}END`;
      code.push(part);
      return token;
    },
  )
    .replace(/\$\$\s*\\\(([\s\S]*?)\\\)\s*\$\$/g, '\n$$\n$1\n$$\n')
    .replace(/\\\[([\s\S]*?)\\\]/g, '\n$$\n$1\n$$\n')
    .replace(/\\\(([\s\S]*?)\\\)/g, ' $$$1$$ ')
    .replace(/\n{3,}/g, '\n\n');
  return result.replace(/CHATMARKDOWNCODE(\d+)END/g, (_, index) => code[Number(index)]);
}

export function renderChatMarkdown(value) {
  const source = normalizeMathDelimiters(String(value ?? ''));
  const html = String(processor.processSync(source));
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}
