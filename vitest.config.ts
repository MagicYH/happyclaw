import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只扫描后端测试目录，排除 web/ 和 container/ 子项目
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['web/**', 'container/**', 'node_modules/**'],
  },
});
