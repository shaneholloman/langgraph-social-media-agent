import { BaseStore } from "@langchain/langgraph";
import { getGitHubRepoURLs } from "../../utils/stores/github-repos.js";
import { Octokit } from "@octokit/rest";
import { sleep } from "../../../utils.js";
import { traceable } from "langsmith/traceable";

function getOctokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  const octokit = new Octokit({
    auth: token,
  });

  return octokit;
}

const JS_LANGCHAIN_PACKAGES = [
  "@langchain/langgraph",
  "@langchain/core",
  "@langchain/community",
  "@langchain/openai",
  "@langchain/anthropic",
];

const PY_LANGCHAIN_PACKAGES = [
  "langgraph",
  "langchain-core",
  "langchain-community",
  "langchain-openai",
  "langchain-anthropic",
];

const JS_PATH_QUERY = "filename:package.json";
const PY_PATH_QUERY_REQUIREMENTS = "filename:requirements.txt";
const PY_PATH_QUERY_PYPROJECT = "filename:pyproject.toml";

const NOT_LANGCHAIN_ORG_QUERY = "NOT org:langchain-ai";

const MAX_REPO_AGE_DAYS = 30;

function isRepoRecentEnough(pushedAt: string | undefined | null): boolean {
  if (!pushedAt) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_REPO_AGE_DAYS);
  return new Date(pushedAt) >= cutoff;
}

const FULL_PY_QUERY = `${PY_PATH_QUERY_REQUIREMENTS} OR ${PY_PATH_QUERY_PYPROJECT} ${NOT_LANGCHAIN_ORG_QUERY}`;
const FULL_JS_QUERY = `${JS_LANGCHAIN_PACKAGES.join(" OR ")} ${JS_PATH_QUERY} ${NOT_LANGCHAIN_ORG_QUERY}`;

async function checkJSDependencies(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });

    if (!("content" in data)) {
      return false;
    }

    const content = Buffer.from(data.content, "base64").toString();
    const packageJson = JSON.parse(content);
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    const langchainDeps = Object.keys(dependencies).filter((dep) =>
      JS_LANGCHAIN_PACKAGES.some((jsDep) => jsDep === dep),
    );

    return langchainDeps.length > 0;
  } catch (error) {
    return false;
  }
}

async function checkPythonDependencies(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });

    if (!("content" in data)) {
      return false;
    }

    if (path.endsWith(".txt")) {
      const content = Buffer.from(data.content, "base64").toString();
      return PY_LANGCHAIN_PACKAGES.some(
        (pkg) =>
          content.includes(pkg) || new RegExp(`${pkg}[-~=]+`).test(content),
      );
    }

    // Assume it's a pyproject.toml file
    if (path.endsWith(".toml")) {
      const content = Buffer.from(data.content, "base64").toString();
      return PY_LANGCHAIN_PACKAGES.some(
        (pkg) =>
          content.includes(pkg) || new RegExp(`${pkg}[-~=]+`).test(content),
      );
    }

    return false;
  } catch (error) {
    return false;
  }
}

async function langchainDependencyReposLoaderFunc(
  store: BaseStore | undefined,
) {
  const octokit = getOctokit();
  const processedRepos = await getGitHubRepoURLs(store);
  const newRepoURLs: string[] = [];
  let page = 0;
  const maxAttempts = 1;

  // Fetch PY repos first
  while (newRepoURLs.length < 5 || page <= maxAttempts) {
    page += 1;

    try {
      const results = await Promise.allSettled(
        PY_LANGCHAIN_PACKAGES.map((pkg) =>
          octokit.search.code({
            q: `${pkg} ${FULL_PY_QUERY}`,
            sort: "indexed",
            order: "desc",
            per_page: 25,
            page,
          }),
        ),
      );

      let incompleteResults = false;
      const filteredResults = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);

      for (const { data } of filteredResults) {
        console.log(`Found ${data.total_count} Python repos`);
        // Only set to true. This is to prevent one query setting it to false when another one returns incomplete results
        if (data.incomplete_results) {
          incompleteResults = data.incomplete_results;
        }

        if (data.total_count === 0) {
          break;
        }

        for (const repo of data.items) {
          const repoUrl = repo.repository.html_url;
          if (
            processedRepos.includes(repoUrl) ||
            !repo.repository.owner ||
            newRepoURLs.some((r) => r === repoUrl)
          ) {
            if (data.incomplete_results) {
              continue;
            } else {
              break;
            }
          }

          if (!isRepoRecentEnough(repo.repository.pushed_at)) {
            continue;
          }

          const hasDeps = await checkPythonDependencies(
            octokit,
            repo.repository.owner.login,
            repo.repository.name,
            repo.path,
          );

          if (hasDeps) {
            newRepoURLs.push(repoUrl);
            if (newRepoURLs.length >= 5) break;
          }

          // Sleep for 30s due to rate limits of 10 req/min.
          console.log("Sleeping...");
          await sleep(30000);
        }
      }

      if (newRepoURLs.length >= 5 || !incompleteResults) break;
    } catch (error) {
      console.error("Failed to fetch repos:", error);
      break;
    }
  }

  // Reset page counter and search for JS repos
  page = 0;
  while (newRepoURLs.length < 10 || page <= maxAttempts) {
    page += 1;

    try {
      const results = await Promise.allSettled(
        JS_LANGCHAIN_PACKAGES.map((pkg) =>
          octokit.search.code({
            q: `${pkg} ${FULL_JS_QUERY}`,
            sort: "indexed",
            order: "desc",
            per_page: 25,
            page,
          }),
        ),
      );

      let incompleteResults = false;
      const filteredResults = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);

      for (const { data } of filteredResults) {
        console.log(`Found ${data.total_count} JS repos`);
        // Only set to true. This is to prevent one query setting it to false when another one returns incomplete results
        if (data.incomplete_results) {
          incompleteResults = data.incomplete_results;
        }

        if (data.total_count === 0) {
          break;
        }

        for (const repo of data.items) {
          const repoUrl = repo.repository.html_url;
          if (
            processedRepos.includes(repoUrl) ||
            !repo.repository.owner ||
            newRepoURLs.some((r) => r === repoUrl)
          ) {
            if (data.incomplete_results) {
              continue;
            } else {
              break;
            }
          }

          if (!isRepoRecentEnough(repo.repository.pushed_at)) {
            continue;
          }

          const hasDeps = await checkJSDependencies(
            octokit,
            repo.repository.owner.login,
            repo.repository.name,
            repo.path,
          );

          if (hasDeps) {
            newRepoURLs.push(repoUrl);
            if (newRepoURLs.length >= 5) break;
          }

          // Sleep for 30s due to rate limits of 10 req/min.
          console.log("Sleeping...");
          await sleep(30000);
        }
      }

      if (newRepoURLs.length >= 25 || !incompleteResults) break;
    } catch (error) {
      console.error("Failed to fetch repos:", error);
      break;
    }
  }

  return newRepoURLs.slice(0, 25);
}

export const langchainDependencyReposLoader = traceable(
  langchainDependencyReposLoaderFunc,
  { name: "github-loader-langchain" },
);
