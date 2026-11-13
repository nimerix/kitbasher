// Binary, one-job helper. Input/output use little-endian IEEE-754 float32 / uint32.
// The supported desktop targets (x64 and arm64) use this representation natively.
#include "meshoptimizer/meshoptimizer.h"
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>
#include <exception>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

static bool read(void* data, size_t bytes) { return std::fread(data,1,bytes,stdin)==bytes; }
static int fail(const char* message) { std::fprintf(stderr,"%s\n",message); return 1; }
int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin),_O_BINARY); _setmode(_fileno(stdout),_O_BINARY);
#endif
  try {
    uint32_t h[9]; float error;
    if(!read(h,sizeof(h)) || !read(&error,4)) return fail("Incomplete mesh request.");
    const uint32_t mode=h[2], vertices=h[3], count=h[4], target=h[5], resolution=h[6], lock=h[7], colors=h[8];
    if(h[0]!=0x4b424d31 || h[1]!=1 || mode>1 || vertices<3 || vertices>30000000 ||
       count<3 || count>30000000 || count%3 || colors>1 || lock>1 ||
       !std::isfinite(error) || error<0 || error>1 ||
       (mode==0 && (target<3 || target>count || target%3)) ||
       (mode==1 && (resolution<24 || resolution>128))) return fail("Invalid mesh kernel request.");
    const size_t bytes=size_t(vertices)*12*(colors?2:1)+size_t(count)*4;
    if(bytes>512u*1024u*1024u) return fail("Native mesh request exceeds the memory limit.");
    std::vector<float> positions(size_t(vertices)*3), attributes(colors?size_t(vertices)*3:0);
    std::vector<unsigned int> indices(count);
    if(!read(positions.data(),positions.size()*4) || !read(indices.data(),indices.size()*4) ||
       (colors && !read(attributes.data(),attributes.size()*4)) || std::fgetc(stdin)!=EOF)
      return fail("Incomplete or oversized mesh request.");
    for(float v:positions) if(!std::isfinite(v)) return fail("Invalid vertex position.");
    for(float v:attributes) if(!std::isfinite(v)) return fail("Invalid vertex color.");
    for(unsigned int i:indices) if(i>=vertices) return fail("Invalid triangle index.");
    std::vector<unsigned int> reduced; std::vector<float> surface;
    size_t result=0; float deviation=0;
    if(mode==0) {
      reduced.resize(count); float weights[3]={1,1,1};
      const unsigned int flags=lock?meshopt_SimplifyLockBorder:0;
      result=colors
        ? meshopt_simplifyWithAttributes(reduced.data(),indices.data(),count,positions.data(),vertices,12,
            attributes.data(),12,weights,3,nullptr,target,error,flags,&deviation)
        : meshopt_simplify(reduced.data(),indices.data(),count,positions.data(),vertices,12,target,error,flags,&deviation);
    } else {
      const size_t capacity=1000000;
      surface.resize(capacity*9);
      result=meshopt_remesh(surface.data(),capacity,indices.data(),count,positions.data(),vertices,12,resolution,0);
      if(result>capacity) return fail("The remesh exceeded one million triangles. Lower voxel resolution.");
      result*=9;
    }
    uint32_t out[3]={0x4b424d31,mode,uint32_t(result)};
    std::fwrite(out,1,sizeof(out),stdout); std::fwrite(&deviation,1,4,stdout);
    std::fwrite(mode==0?static_cast<void*>(reduced.data()):static_cast<void*>(surface.data()),4,result,stdout);
    return std::ferror(stdout)?1:0;
  } catch(const std::exception& error) { return fail(error.what()); }
}
