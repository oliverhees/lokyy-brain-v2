import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { App } from './App.tsx';

// Follow the OS colour scheme (tokens.css keys the themes off data-theme).
const media = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.setAttribute('data-theme', media.matches ? 'dark' : 'light');
applyTheme();
media.addEventListener('change', applyTheme);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
