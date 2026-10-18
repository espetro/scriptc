#pragma once

#include <optional>
#include <string>
#include <vector>

namespace scriptc {

struct EmitOptions {
  std::string Input;
  // One output per program partition; several require object output.
  std::vector<std::string> Outputs;
  std::string FileType = "obj";
  std::string Target;
  std::string OptLevel = "2";
  std::string RelocationModel = "pic";
  std::string DiagnosticFormat = "json";
  std::string SourcePath;
  // Runtime bitcode whose small functions are imported available_externally.
  std::vector<std::string> ImportBitcode;
  // Private directory for reusable partition artifacts; empty disables reuse.
  std::string CacheDirectory;
  // Worker threads for partition compilation; 0 follows SCRIPTC_JOBS, then
  // the host's hardware concurrency.
  unsigned Jobs = 0;
};

std::optional<EmitOptions> parseEmitOptions(int Argc, char **Argv);
int emit(const EmitOptions &Options);

} // namespace scriptc
