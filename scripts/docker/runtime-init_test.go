package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestCopyMissingConcurrent(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()

	for index := 0; index < 64; index++ {
		name := filepath.Join(source, fmt.Sprintf("asset-%02d.txt", index))
		if err := os.WriteFile(name, []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}

	const workers = 32
	start := make(chan struct{})
	errors := make(chan error, workers)
	var waitGroup sync.WaitGroup
	for index := 0; index < workers; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			<-start
			errors <- copyMissing(source, destination)
		}()
	}

	close(start)
	waitGroup.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("concurrent copy failed: %v", err)
		}
	}

	entries, err := os.ReadDir(destination)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 64 {
		t.Fatalf("copied %d assets, want 64", len(entries))
	}
}

func TestEnsureTreeOwnershipSkipsOwnedPrivateChildren(t *testing.T) {
	root := t.TempDir()
	privateDirectory := filepath.Join(root, "locks")
	if err := os.Mkdir(privateDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(privateDirectory, "lock"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(privateDirectory, 0000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(privateDirectory, 0700) })

	if err := ensureTreeOwnership(root, os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("owned tree should not be traversed: %v", err)
	}
}
