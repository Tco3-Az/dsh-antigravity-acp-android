#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static void *(*real_dlopen)(const char *filename, int flag) = NULL;
#if defined(__GLIBC__)
static void *(*real_dlmopen)(Lmid_t lmid, const char *filename, int flag) = NULL;
#endif
static int (*real_open)(const char *pathname, int flags, ...) = NULL;
static int (*real_openat)(int dirfd, const char *pathname, int flags, ...) = NULL;

static void init_real_functions(void) {
    if (!real_dlopen) {
        real_dlopen = (void *(*)(const char *, int))dlsym(RTLD_NEXT, "dlopen");
    }
#if defined(__GLIBC__)
    if (!real_dlmopen) {
        real_dlmopen = (void *(*)(Lmid_t, const char *, int))dlsym(RTLD_NEXT, "dlmopen");
    }
#endif
    if (!real_open) {
        real_open = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open");
    }
    if (!real_openat) {
        real_openat = (int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, "openat");
    }
}

static int fd_from_path(const char *path) {
    if (!path) return -1;
    const char *prefix = NULL;
    if (strncmp(path, "/proc/self/fd/", 14) == 0) {
        prefix = path + 14;
    } else if (strncmp(path, "/dev/fd/", 8) == 0) {
        prefix = path + 8;
    } else if (strncmp(path, "/proc/", 6) == 0) {
        const char *p = path + 6;
        while (*p >= '0' && *p <= '9') p++;
        if (strncmp(p, "/fd/", 4) == 0) {
            prefix = p + 4;
        }
    }
    if (!prefix || *prefix == '\0') return -1;
    char *endptr = NULL;
    long fd = strtol(prefix, &endptr, 10);
    if (endptr == prefix || *endptr != '\0' || fd < 0 || fd > 65535) {
        return -1;
    }
    return (int)fd;
}

static int materialize_fd_to_tmp(int fd, char *out_path, size_t out_path_size) {
    struct stat st;
    if (fstat(fd, &st) != 0) {
        return -1;
    }

    const char *tmp_dir = getenv("TMPDIR");
    if (!tmp_dir || *tmp_dir == '\0') tmp_dir = "/tmp";

    int written = snprintf(out_path, out_path_size, "%s/agy-dlopen-XXXXXX", tmp_dir);
    if (written < 0 || (size_t)written >= out_path_size) {
        return -1;
    }

    int tmp_fd = mkstemp(out_path);
    if (tmp_fd < 0) {
        return -1;
    }

    // Copy contents from memfd using pread
    char buffer[65536];
    off_t offset = 0;
    off_t remaining = st.st_size;

    while (remaining > 0) {
        size_t chunk = (remaining > (off_t)sizeof(buffer)) ? sizeof(buffer) : (size_t)remaining;
        ssize_t bytes_read = pread(fd, buffer, chunk, offset);
        if (bytes_read <= 0) {
            if (bytes_read < 0 && errno == EINTR) continue;
            break;
        }
        ssize_t written_now = 0;
        while (written_now < bytes_read) {
            ssize_t w = write(tmp_fd, buffer + written_now, (size_t)(bytes_read - written_now));
            if (w < 0) {
                if (errno == EINTR) continue;
                close(tmp_fd);
                unlink(out_path);
                return -1;
            }
            written_now += w;
        }
        offset += bytes_read;
        remaining -= bytes_read;
    }

    fchmod(tmp_fd, 0700);
    close(tmp_fd);
    return 0;
}

void *dlopen(const char *filename, int flag) {
    init_real_functions();
    int fd = fd_from_path(filename);
    if (fd >= 0) {
        char tmp_path[PATH_MAX];
        if (materialize_fd_to_tmp(fd, tmp_path, sizeof(tmp_path)) == 0) {
            void *handle = real_dlopen(tmp_path, flag);
            unlink(tmp_path);
            return handle;
        }
    }
    return real_dlopen(filename, flag);
}

#if defined(__GLIBC__)
void *dlmopen(Lmid_t lmid, const char *filename, int flag) {
    init_real_functions();
    int fd = fd_from_path(filename);
    if (fd >= 0) {
        char tmp_path[PATH_MAX];
        if (materialize_fd_to_tmp(fd, tmp_path, sizeof(tmp_path)) == 0) {
            void *handle = real_dlmopen(lmid, tmp_path, flag);
            unlink(tmp_path);
            return handle;
        }
    }
    return real_dlmopen(lmid, filename, flag);
}
#endif

int open(const char *pathname, int flags, ...) {
    init_real_functions();
    int fd = fd_from_path(pathname);
    if (fd >= 0) {
        int dup_fd = fcntl(fd, F_DUPFD_CLOEXEC, 0);
        if (dup_fd >= 0) return dup_fd;
    }
    va_list args;
    va_start(args, flags);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        mode = va_arg(args, mode_t);
    }
    va_end(args);
    return real_open(pathname, flags, mode);
}

int open64(const char *pathname, int flags, ...) __attribute__((alias("open")));

int openat(int dirfd, const char *pathname, int flags, ...) {
    init_real_functions();
    if (dirfd == AT_FDCWD || (pathname && pathname[0] == '/')) {
        int fd = fd_from_path(pathname);
        if (fd >= 0) {
            int dup_fd = fcntl(fd, F_DUPFD_CLOEXEC, 0);
            if (dup_fd >= 0) return dup_fd;
        }
    }
    va_list args;
    va_start(args, flags);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        mode = va_arg(args, mode_t);
    }
    va_end(args);
    return real_openat(dirfd, pathname, flags, mode);
}

int openat64(int dirfd, const char *pathname, int flags, ...) __attribute__((alias("openat")));
