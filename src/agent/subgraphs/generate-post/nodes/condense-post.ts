import { ChatAnthropic } from "@langchain/anthropic";
import { GraphAnnotation } from "../generate-post-state.js";
import { STRUCTURE_INSTRUCTIONS, RULES } from "./geterate-post/prompts.js";
import { parseGeneration } from "./geterate-post/utils.js";

const CONDENSE_POST_PROMPT = `You're a highly skilled marketer at LangChain, working on crafting thoughtful and engaging content for LangChain's LinkedIn and Twitter pages.
You wrote a post for the LangChain LinkedIn and Twitter pages, however it's a bit too long for Twitter, and thus needs to be condensed.

You wrote this marketing report on the content which you used to write the original post:
<report>
{report}
</report>

And the content has the following link that should ALWAYS be included in the final post:
<link>
{link}
</link>

You should not be worried by the length of the link, as that will be shortened before posting. Only focus on condensing the length of the post content itself.

Here are the rules and structure you used to write the original post, which you should use when condensing the post now:
<rules-and-structure>

<structure-instructions>
${STRUCTURE_INSTRUCTIONS}
</structure-instructions>

<rules>
${RULES}
</rules>

</rules-and-structure>

Given the marketing report, link, rules and structure, please condense the post down to roughly 280 characters (not including the link. Going over 280 characters is okay, but ensure it's close to 280). The original post was {originalPostLength} characters long.
Ensure you keep the same structure, and do not omit any crucial content outright.

Follow this flow to rewrite the post in a condensed format:

<rewriting-flow>
1. Carefully read over the report, original post provided by the user below, the rules and structure.
2. Write down your thoughts about where and how you can condense the post inside <thinking> tags. This should contain details you think will help make the post more engaging, snippets you think can be condensed, etc. This should be the first text you write.
3. Using all the context provided to you above, the original post, and your thoughts, rewrite the post in a condensed format inside <post> tags. This should be the last text you write.
</rewriting-flow>

Follow all rules and instructions outlined above. The user message below will provide the original post. Remember to have fun while rewriting it! Go!`;

/**
 * Attempts to condense a post if the original generation is longer than 300 characters.
 * @param state The state of the graph
 * @returns A partial state of the graph
 */
export async function condensePost(
  state: typeof GraphAnnotation.State,
): Promise<Partial<typeof GraphAnnotation.State>> {
  if (!state.post) {
    throw new Error("No post found");
  }
  if (!state.report) {
    throw new Error("No report found");
  }
  if (state.relevantLinks.length === 0) {
    throw new Error("No relevant links found");
  }

  const formattedSystemPrompt = CONDENSE_POST_PROMPT.replace(
    "{report}",
    state.report,
  )
    .replace("{link}", state.relevantLinks[0])
    .replace("{originalPostLength}", state.post.length.toString());

  const condensePostModel = new ChatAnthropic({
    model: "claude-3-5-sonnet-20241022",
    temperature: 0.5,
  });

  const userMessageContent = `Here is the original post:\n\n${state.post}`;

  const condensePostResponse = await condensePostModel.invoke([
    {
      role: "system",
      content: formattedSystemPrompt,
    },
    {
      role: "user",
      content: userMessageContent,
    },
  ]);

  return {
    post: parseGeneration(condensePostResponse.content as string),
  };
}
