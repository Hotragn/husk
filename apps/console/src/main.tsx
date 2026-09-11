// First, and it has to stay first: `@husk/core`'s barrel builds a stderr
// logger at import time, so `process` must exist before anything reaches
// `@husk/sdk`. See src/shims/process.ts.
import './shims/process';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
