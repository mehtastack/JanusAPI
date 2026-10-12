import { configure } from '@testing-library/dom';

// findBy* and waitFor give up after 1 s by default; opening a collection can take longer on a loaded CI runner (Windows).
configure({ asyncUtilTimeout: 5_000 });
