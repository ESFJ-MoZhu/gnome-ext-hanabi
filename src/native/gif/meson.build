cmake_exe = find_program('cmake')
sh_exe = find_program('sh')

gif_build_dir = meson.current_build_dir() / 'cmake-build'
gif_artifacts = custom_target(
  'hanabi-gif-artifacts',
  input: files(
    'CMakeLists.txt',
    'hanabi-gif-paintable.c',
    'hanabi-gif-paintable.h',
  ),
  output: [
    'libHanabiGif.so',
    'HanabiGif-1.0.typelib',
  ],
  command: [
    sh_exe, '-eu', '-c',
    'echo "==> Configuring HanabiGif CMake project" && ' +
    '"$1" -S "$2" -B "$3" -DCMAKE_BUILD_TYPE=RelWithDebInfo && ' +
    'echo "==> Building HanabiGif native bridge" && ' +
    '"$1" --build "$3" --verbose && ' +
    'echo "==> Collecting HanabiGif build artifacts" && ' +
    '"$1" -E copy_if_different "$3/out/libHanabiGif.so" "$4" && ' +
    '"$1" -E copy_if_different "$3/out/gir/HanabiGif-1.0.typelib" "$5"',
    'sh',
    cmake_exe,
    meson.current_source_dir(),
    gif_build_dir,
    '@OUTPUT0@',
    '@OUTPUT1@',
  ],
  build_by_default: true,
  build_always_stale: true,
  console: true,
  install: true,
  install_dir: [
    libdir,
    typelib_dir,
  ],
)
