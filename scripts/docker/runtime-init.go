package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
)

const maxRuntimeID = 2147483647

func parseRuntimeID(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || value < 1 || value > maxRuntimeID {
		return 0, fmt.Errorf("%s must be between 1 and %d", name, maxRuntimeID)
	}
	return int(value), nil
}

func copyMissing(source, destination string) error {
	entries, err := os.ReadDir(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := os.MkdirAll(destination, 0755); err != nil {
		return err
	}

	for _, entry := range entries {
		sourcePath := filepath.Join(source, entry.Name())
		destinationPath := filepath.Join(destination, entry.Name())
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing image symlink %s", sourcePath)
		}
		if info.IsDir() {
			if err := copyMissing(sourcePath, destinationPath); err != nil {
				return err
			}
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if _, err := os.Lstat(destinationPath); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}

		input, err := os.Open(sourcePath)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(
			destinationPath,
			os.O_WRONLY|os.O_CREATE|os.O_EXCL,
			info.Mode().Perm(),
		)
		if errors.Is(err, os.ErrExist) {
			// Blue and green share the image volume and may start at the same
			// time after a Docker daemon restart. Another container winning the
			// O_EXCL race means the default asset is already available.
			if closeErr := input.Close(); closeErr != nil {
				return closeErr
			}
			continue
		}
		if err != nil {
			_ = input.Close()
			return err
		}

		_, err = io.Copy(output, input)
		closeErr := output.Close()
		if err == nil {
			err = closeErr
		}
		inputCloseErr := input.Close()
		if err == nil {
			err = inputCloseErr
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func chownTree(path string, uid, gid int) error {
	return filepath.WalkDir(path, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		return os.Lchown(currentPath, uid, gid)
	})
}

func ownershipMatches(path string, uid, gid int) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false, fmt.Errorf("read ownership for %s: unsupported stat type", path)
	}
	return int(stat.Uid) == uid && int(stat.Gid) == gid, nil
}

func ensureTreeOwnership(path string, uid, gid int) error {
	matches, err := ownershipMatches(path, uid, gid)
	if err != nil {
		return err
	}
	if matches {
		// Caddy creates private runtime directories such as locks/ with mode
		// 0700. The root init intentionally has no DAC_OVERRIDE capability, so
		// traversing an already-correct tree would fail on the next restart.
		return nil
	}
	return chownTree(path, uid, gid)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "No command provided")
		os.Exit(64)
	}

	uid, err := parseRuntimeID("PUID", 1000)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(64)
	}
	gid, err := parseRuntimeID("PGID", 1000)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(64)
	}

	writableDirectories := []string{
		"/opt/app/backend/data",
		"/opt/app/frontend/public/img",
		"/home/privcloud-sharing/.config/caddy",
		"/home/privcloud-sharing/.local/share/caddy",
	}
	for _, directory := range writableDirectories {
		if err := os.MkdirAll(directory, 0755); err != nil {
			fmt.Fprintf(os.Stderr, "prepare %s: %v\n", directory, err)
			os.Exit(1)
		}
	}
	if os.Geteuid() == 0 {
		fmt.Printf("Preparing runtime identity %d:%d (restart-safe ownership)...\n", uid, gid)
		for _, directory := range writableDirectories {
			if err := ensureTreeOwnership(directory, uid, gid); err != nil {
				fmt.Fprintf(os.Stderr, "chown %s: %v\n", directory, err)
				os.Exit(1)
			}
		}
		if err := syscall.Setgroups([]int{}); err != nil {
			fmt.Fprintf(os.Stderr, "clear supplementary groups: %v\n", err)
			os.Exit(1)
		}
		if err := syscall.Setgid(gid); err != nil {
			fmt.Fprintf(os.Stderr, "set gid: %v\n", err)
			os.Exit(1)
		}
		if err := syscall.Setuid(uid); err != nil {
			fmt.Fprintf(os.Stderr, "set uid: %v\n", err)
			os.Exit(1)
		}
	}

	// Copy as the final runtime identity. Newly added defaults therefore get
	// the correct ownership without another privileged recursive traversal.
	if err := copyMissing("/tmp/img", "/opt/app/frontend/public/img"); err != nil {
		fmt.Fprintf(os.Stderr, "copy default images: %v\n", err)
		os.Exit(1)
	}

	command, err := exec.LookPath(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(127)
	}
	if err := syscall.Exec(command, os.Args[1:], os.Environ()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(126)
	}
}
