import * as B from 'fp-ts/lib/boolean.js';
import * as O from 'fp-ts/lib/Option.js';
import * as RA from 'fp-ts/lib/ReadonlyArray.js';
import * as S from 'fp-ts/lib/string.js';
import * as path from 'node:path';

export type ComputeCommonRootDir = (filePaths: ReadonlyArray<string>) => string;

const splitDirParts = (filePath: string) => path.dirname(path.resolve(filePath)).split(path.sep);

type MatchPartInput = {
  readonly headPart: O.Option<string>;
  readonly idx: number;
};

const matchesHeadPartAt =
  ({ headPart, idx }: MatchPartInput) =>
  (parts: ReadonlyArray<string>) =>
    O.getEq(S.Eq).equals(RA.lookup(idx)(parts), headPart);

type AllMatchInput = {
  readonly headParts: ReadonlyArray<string>;
  readonly allParts: ReadonlyArray<ReadonlyArray<string>>;
};

const allMatchAt =
  ({ headParts, allParts }: AllMatchInput) =>
  (idx: number) =>
    RA.every(matchesHeadPartAt({ headPart: RA.lookup(idx)(headParts), idx }))(allParts);

const lookupHeadPart = (headParts: ReadonlyArray<string>) => (idx: number) =>
  O.getOrElse(() => '')(RA.lookup(idx)(headParts));

const computeWithHead =
  (allParts: ReadonlyArray<ReadonlyArray<string>>) => (headParts: ReadonlyArray<string>) => {
    const commonIndices = B.match(
      () => [] satisfies ReadonlyArray<number>,
      () => RA.takeLeftWhile(allMatchAt({ headParts, allParts }))(RA.range(0, headParts.length - 1)),
    )(headParts.length > 0);
    const joined = RA.map(lookupHeadPart(headParts))(commonIndices).join(path.sep);
    return B.match(
      () => path.sep,
      () => joined,
    )(joined.length > 0);
  };

const computeFromNonEmpty = (filePaths: ReadonlyArray<string>) => {
  const allParts = RA.map(splitDirParts)(filePaths);
  return O.match(
    () => process.cwd(),
    computeWithHead(allParts),
  )(RA.head(allParts));
};

export const computeCommonRootDir = ((filePaths) =>
  B.match(
    () => process.cwd(),
    () => computeFromNonEmpty(filePaths),
  )(filePaths.length > 0)) satisfies ComputeCommonRootDir;
