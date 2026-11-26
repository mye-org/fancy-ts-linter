import * as path from 'node:path';
import { toRelativePosixPath, type RelativePathInput } from './toRelativePosixPath.js';

export type ToRelativeDirectory = (input: RelativePathInput) => string;

export const toRelativeDirectory = (({ rootDir, filePath }) =>
  path.posix.dirname(toRelativePosixPath({ rootDir, filePath }))) satisfies ToRelativeDirectory;
