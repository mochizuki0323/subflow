import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import { App } from './App';
import '../shared/styles/control-panel.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
