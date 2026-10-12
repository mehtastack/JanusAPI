import { useState } from 'react';
import { useActions } from '../App';
import { BrandMark, Wordmark } from './BrandMark';

export function Welcome() {
  const actions = useActions();
  const [name, setName] = useState('');
  return (
    <main className="welcome">
      <h1 aria-label="JanusAPI"><BrandMark size={40} /><Wordmark /></h1>
      <p>Open a collection folder, or create a new one.</p>
      <button type="button" onClick={() => void actions.openCollection()}>Open collection…</button>
      <button type="button" onClick={() => void actions.openDemo()}>Open demo collection</button>
      <button type="button" onClick={() => actions.openImport('openapi', { kind: 'new-collection' })}>Import OpenAPI…</button>
      <button type="button" onClick={() => actions.openImport('postman', { kind: 'new-collection' })}>Import Postman…</button>
      <form
        className="new-collection"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void actions.createCollection(name.trim());
        }}
      >
        <label>
          <span>Collection name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit">New collection…</button>
      </form>
    </main>
  );
}
