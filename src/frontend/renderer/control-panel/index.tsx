import React from 'react';
import { createRoot } from 'react-dom/client';
// The machine layer is monospaced; only human speech gets a proportional face.
// Neither family carries CJK, so Chinese and Japanese fall through to the system
// stack in both roles — which is what keeps the bilingual UI coherent.
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import { App } from './App';
import '../shared/styles/control-panel.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
