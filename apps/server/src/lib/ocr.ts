import { createWorker } from 'tesseract.js';
import { tesseractWorkerOptions } from './tesseract-cache';

export async function extractText(imagePath: string): Promise<string> {
  const worker = await createWorker('eng', undefined, tesseractWorkerOptions());
  try {
    const { data } = await worker.recognize(imagePath);
    return data.text.trim();
  } finally {
    await worker.terminate();
  }
}
