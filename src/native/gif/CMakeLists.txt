cmake_minimum_required(VERSION 3.14)
project(HanabiGif LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GTK4 REQUIRED gtk4)
pkg_check_modules(GLYCIN REQUIRED glycin-2)
pkg_check_modules(GLYCIN_GTK4 REQUIRED glycin-gtk4-2)
pkg_check_modules(GI REQUIRED gobject-introspection-1.0)

find_program(G_IR_SCANNER g-ir-scanner REQUIRED)
find_program(G_IR_COMPILER g-ir-compiler REQUIRED)

add_library(HanabiGif SHARED
  hanabi-gif-paintable.c
)

target_include_directories(HanabiGif
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
  PRIVATE
    ${GTK4_INCLUDE_DIRS}
    ${GLYCIN_INCLUDE_DIRS}
    ${GLYCIN_GTK4_INCLUDE_DIRS}
    ${GI_INCLUDE_DIRS}
)

target_compile_options(HanabiGif PRIVATE ${GTK4_CFLAGS_OTHER} ${GLYCIN_CFLAGS_OTHER} ${GLYCIN_GTK4_CFLAGS_OTHER})
target_link_libraries(HanabiGif PRIVATE ${GTK4_LIBRARIES} ${GLYCIN_LIBRARIES} ${GLYCIN_GTK4_LIBRARIES})

set_target_properties(HanabiGif PROPERTIES
  OUTPUT_NAME HanabiGif
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/out
)

set(GIF_OUT_DIR ${CMAKE_CURRENT_BINARY_DIR}/out)
set(GIF_GIR_DIR ${GIF_OUT_DIR}/gir)
set(GIF_GIR ${GIF_GIR_DIR}/HanabiGif-1.0.gir)
set(GIF_TYPELIB ${GIF_GIR_DIR}/HanabiGif-1.0.typelib)

file(MAKE_DIRECTORY ${GIF_GIR_DIR})
set(GIF_GIR_CACHE_DIR ${CMAKE_CURRENT_BINARY_DIR}/gir-cache)
file(MAKE_DIRECTORY ${GIF_GIR_CACHE_DIR})

add_custom_command(
  OUTPUT ${GIF_GIR}
  COMMAND ${CMAKE_COMMAND} -E make_directory ${GIF_GIR_DIR}
  COMMAND ${CMAKE_COMMAND} -E env
          XDG_CACHE_HOME=${GIF_GIR_CACHE_DIR}
          LD_LIBRARY_PATH=${GIF_OUT_DIR}:$ENV{LD_LIBRARY_PATH}
          ${G_IR_SCANNER}
          --warn-all
          --namespace=HanabiGif
          --nsversion=1.0
          --library=HanabiGif
          --library-path=${GIF_OUT_DIR}
          --output ${GIF_GIR}
          --identifier-prefix=Hanabi
          --symbol-prefix=hanabi
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-gif-paintable.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-gif-paintable.c
          --include=GObject-2.0
          --include=Gio-2.0
          --include=Gdk-4.0
          --include=Gtk-4.0
          --include=Gly-2
          --include=GlyGtk4-2
          --pkg gtk4
          --pkg glycin-2
          --pkg glycin-gtk4-2
          --pkg gobject-2.0
          --pkg gio-2.0
          --cflags-begin
          ${GTK4_CFLAGS}
          ${GLYCIN_CFLAGS}
          ${GLYCIN_GTK4_CFLAGS}
          -I${CMAKE_CURRENT_SOURCE_DIR}
          --cflags-end
  DEPENDS HanabiGif
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-gif-paintable.h
          ${CMAKE_CURRENT_SOURCE_DIR}/hanabi-gif-paintable.c
  VERBATIM
)

add_custom_command(
  OUTPUT ${GIF_TYPELIB}
  COMMAND ${G_IR_COMPILER} ${GIF_GIR} -o ${GIF_TYPELIB}
  DEPENDS ${GIF_GIR}
  VERBATIM
)

add_custom_target(HanabiGifTypelib ALL DEPENDS ${GIF_TYPELIB})
