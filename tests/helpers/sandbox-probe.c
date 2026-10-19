#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;

  int forbidden = open(argv[1], O_RDONLY);
  int allowed = open(argv[2], O_RDONLY);
  pid_t child = fork();
  if (child == 0) _exit(0);
  if (child > 0) waitpid(child, NULL, 0);
  printf("{\"forbiddenReadable\":%s,\"inputReadable\":%s,\"forkAllowed\":%s,\"secretEnvironment\":%s}\n", forbidden >= 0 ? "true" : "false", allowed >= 0 ? "true" : "false", child >= 0 ? "true" : "false", getenv("WIKI_SECRET_TEST") ? "true" : "false");
  if (forbidden >= 0) close(forbidden);
  if (allowed >= 0) close(allowed);
  return 0;
}
