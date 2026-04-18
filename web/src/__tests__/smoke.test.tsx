import { render, screen } from '@testing-library/react';
import { describe, test, expect } from 'vitest';

describe('harness smoke test', () => {
  test('harness works', () => {
    render(<div>Hello</div>);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
