#pragma once

#include "llvm/ADT/StringRef.h"
#include "llvm/ADT/StringSet.h"

#include <optional>
#include <string>
#include <vector>

namespace scriptc {

// A program module divided into independently compilable textual modules.
struct ProgramPartitions {
  // One complete LLVM assembly module per partition.
  std::vector<std::string> Sources;
  // Definitions that were not internal in the original module. Every other
  // definition was internal and is promoted to hidden visibility only so the
  // partitions can reference each other.
  llvm::StringSet<> PublicSymbols;
};

// Divides the LLVM assembly scriptc emits into Count modules without parsing
// it, so the partitions can be parsed concurrently. Functions are placed by a
// stable hash of their name; an internal function referenced by exactly one
// other function stays with that function, and a global stays with the first
// function that references it. Returns nullopt for any construct outside the
// emitter's narrow top-level grammar; callers then split a parsed module.
// Jobs bounds the assembly worker pool; 0 uses the host default.
std::optional<ProgramPartitions> partitionProgramText(llvm::StringRef Text,
                                                      unsigned Count,
                                                      unsigned Jobs = 0);

} // namespace scriptc
