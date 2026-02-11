"""
Dataloader for CVR audio dataset from manifest files
Compatible with the training pipeline
"""

import pandas as pd
import torch
import torchaudio
from torch.utils.data import Dataset, DataLoader
from pathlib import Path
import numpy as np


class CVRDataset(Dataset):
    """CVR Audio Dataset from manifest file"""

    def __init__(self, manifest_path, audio_duration=4.0, sample_rate=16000, is_train=False):
        """
        Args:
            manifest_path: Path to CSV manifest file
            audio_duration: Target duration in seconds
            sample_rate: Target sample rate
            is_train: Whether this is training data (for augmentation)
        """
        self.manifest = pd.read_csv(manifest_path)
        self.audio_duration = audio_duration
        self.sample_rate = sample_rate
        self.is_train = is_train
        self.target_length = int(audio_duration * sample_rate)

        print(f"Loaded {len(self.manifest)} samples from {manifest_path}")
        print(f"  Audio duration: {audio_duration}s")
        print(f"  Sample rate: {sample_rate} Hz")
        print(f"  Target length: {self.target_length} samples")

    def __len__(self):
        return len(self.manifest)

    def _load_audio(self, filepath):
        """Load and preprocess audio file"""
        waveform, sr = torchaudio.load(filepath)

        # Convert to mono if stereo
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        # Resample if needed
        if sr != self.sample_rate:
            resampler = torchaudio.transforms.Resample(sr, self.sample_rate)
            waveform = resampler(waveform)

        # Remove channel dimension
        waveform = waveform.squeeze(0)

        return waveform

    def _pad_or_trim(self, waveform):
        """Pad or trim waveform to target length"""
        current_length = waveform.shape[0]

        if current_length < self.target_length:
            # Pad with zeros
            padding = self.target_length - current_length
            waveform = torch.nn.functional.pad(waveform, (0, padding))
        elif current_length > self.target_length:
            # Trim (random crop for training, center crop for eval)
            if self.is_train:
                start = torch.randint(0, current_length - self.target_length + 1, (1,)).item()
            else:
                start = (current_length - self.target_length) // 2
            waveform = waveform[start:start + self.target_length]

        return waveform

    def __getitem__(self, idx):
        """Get a single sample"""
        row = self.manifest.iloc[idx]

        # Load audio
        filepath = row['filepath']
        waveform = self._load_audio(filepath)

        # Pad or trim to target length
        waveform = self._pad_or_trim(waveform)

        # Get label
        label = int(row['label'])

        # Return waveform, label, and length
        length = torch.tensor(waveform.shape[0], dtype=torch.long)

        return waveform, label, length


def collate_fn(batch):
    """Custom collate function for batching"""
    waveforms, labels, lengths = zip(*batch)

    # Stack into tensors
    waveforms = torch.stack(waveforms)
    labels = torch.tensor(labels, dtype=torch.long)
    lengths = torch.stack(lengths)

    return waveforms, labels, lengths


def make_dataloader(manifest_path, batch_size, audio_duration, is_train=False, num_workers=0):
    """
    Create dataloader for CVR dataset

    Args:
        manifest_path: Path to manifest CSV
        batch_size: Batch size
        audio_duration: Audio duration in seconds
        is_train: Whether this is training data
        num_workers: Number of workers for data loading (use 0 for Windows)

    Returns:
        DataLoader
    """
    dataset = CVRDataset(
        manifest_path=manifest_path,
        audio_duration=audio_duration,
        sample_rate=16000,
        is_train=is_train
    )

    dataloader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=is_train,
        num_workers=num_workers,  # Set to 0 for Windows
        collate_fn=collate_fn,
        pin_memory=True,
        drop_last=is_train
    )

    return dataloader


def class_weights_from_manifest(manifest_path):
    """
    Calculate class weights for imbalanced dataset

    Args:
        manifest_path: Path to manifest CSV

    Returns:
        torch.Tensor: Class weights
    """
    df = pd.read_csv(manifest_path)

    # Count samples per class
    class_counts = df['label'].value_counts().sort_index()

    # Calculate weights (inverse frequency)
    total = len(df)
    num_classes = len(class_counts)
    weights = torch.zeros(num_classes)

    for class_idx, count in class_counts.items():
        weights[class_idx] = total / (num_classes * count)

    return weights


if __name__ == "__main__":
    # Test the dataloader
    import sys

    if len(sys.argv) < 2:
        print("Usage: python cvr_manifest.py <path_to_manifest.csv>")
        sys.exit(1)

    manifest_path = sys.argv[1]

    print(f"Testing dataloader with: {manifest_path}")

    # Create dataloader
    dataloader = make_dataloader(
        manifest_path=manifest_path,
        batch_size=4,
        audio_duration=4.0,
        is_train=True
    )

    # Test loading a batch
    for batch_idx, (waveforms, labels, lengths) in enumerate(dataloader):
        print(f"\nBatch {batch_idx}:")
        print(f"  Waveforms shape: {waveforms.shape}")
        print(f"  Labels: {labels}")
        print(f"  Lengths: {lengths}")

        if batch_idx == 2:  # Just test 3 batches
            break

    # Test class weights
    weights = class_weights_from_manifest(manifest_path)
    print(f"\nClass weights: {weights}")