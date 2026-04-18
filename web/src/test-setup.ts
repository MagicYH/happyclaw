import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// Mock wsManager to avoid real WebSocket in tests
import { vi } from 'vitest';
vi.mock('./api/ws', () => ({
  wsManager: {
    on: vi.fn(() => () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    isConnected: () => false,
    setupNetworkListeners: vi.fn(),
  },
}));
