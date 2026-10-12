/// <reference types="vite/client" />
import type { ApiJanusBridge } from '../../shared/api';
declare global {
  interface Window { apijanus: ApiJanusBridge }
}
export {};
