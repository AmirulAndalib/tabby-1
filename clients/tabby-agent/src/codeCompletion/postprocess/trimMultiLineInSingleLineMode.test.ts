import { CompletionResultItem } from "../solution";
import { documentContext, inline, assertFilterResult } from "./testUtils";
import { trimMultiLineInSingleLineMode } from "./trimMultiLineInSingleLineMode";

describe("postprocess", () => {
  describe("trimMultiLineInSingleLineMode", () => {
    const filter = trimMultiLineInSingleLineMode();
    it("should trim multiline completions, when the suffix have non-auto-closed chars in the current line.", async () => {
      const context = documentContext`javascript
        let error = new Error("Something went wrong");
        console.log(║message);
      `;
      const completion = inline`
                    ├message);
        throw error;┤
      `;
      const expected = new CompletionResultItem("");
      await assertFilterResult(filter, context, completion, expected);
    });

    it("should trim multiline completions, when the suffix have non-auto-closed chars in the current line.", async () => {
      const context = documentContext`javascript
        let error = new Error("Something went wrong");
        console.log(║message);
      `;
      const completion = inline`
                    ├error, message);
        throw error;┤
      `;
      const expected = inline`
                    ├error, ┤
      `;
      await assertFilterResult(filter, context, completion, expected);
    });

    it("should allow singleline completions, when the suffix have non-auto-closed chars in the current line.", async () => {
      const context = documentContext`javascript
        let error = new Error("Something went wrong");
        console.log(║message);
      `;
      const completion = inline`
                    ├error, ┤
      `;
      const expected = completion;
      await assertFilterResult(filter, context, completion, expected);
    });

    it("should allow multiline completions, when the suffix only have auto-closed chars that will be replaced in the current line, such as `)]}`.", async () => {
      const context = documentContext`javascript
        function findMax(arr) {║}
      `;
      const completion = inline`
                               ├
          let max = arr[0];
          for (let i = 1; i < arr.length; i++) {
            if (arr[i] > max) {
              max = arr[i];
            }
          }
          return max;
        }┤
      `;
      const expected = completion;
      await assertFilterResult(filter, context, completion, expected);
    });
  });
});
