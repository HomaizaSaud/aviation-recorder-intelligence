"""
Wav2Vec2 wrapper for speech emotion/stress detection.
Uses HuggingFace transformers with optional LoRA fine-tuning.
"""
import torch
import torch.nn as nn
from transformers import Wav2Vec2Model
import logging


class Wav2VecWrapper(nn.Module):
    """
    Wrapper for Wav2Vec2 pretrained model with a classification head.
    """

    def __init__(self, args, output_class_num=2):
        super().__init__()
        self.args = args
        self.output_class_num = output_class_num

        # Load pretrained Wav2Vec2
        logging.info("Loading Wav2Vec2 model...")
        try:
            self.wav2vec = Wav2Vec2Model.from_pretrained("facebook/wav2vec2-base")
            self.hidden_size = 768  # wav2vec2-base hidden size
        except Exception as e:
            logging.error(f"Failed to load wav2vec2-base: {e}")
            raise

        # Freeze base model (we'll only train the head)
        if args.finetune_method == "lora":
            self._setup_lora()
        elif args.finetune_method == "full":
            logging.info("Full fine-tuning enabled")
        else:
            # Freeze everything by default
            for param in self.wav2vec.parameters():
                param.requires_grad = False
            logging.info("Base model frozen - only training classification head")

        # Pooling layer
        self.pooling_type = args.pooling
        if self.pooling_type == "attn":
            self.attention_pooling = nn.Sequential(
                nn.Linear(self.hidden_size, 1),
                nn.Softmax(dim=1)
            )

        # Downstream classifier
        self.downstream = self._build_downstream(args)

        logging.info(f"Wav2Vec2 wrapper initialized with {self.output_class_num} classes")

    def _setup_lora(self):
        """Setup LoRA fine-tuning if peft is available."""
        try:
            from peft import LoraConfig, get_peft_model

            lora_config = LoraConfig(
                r=self.args.lora_rank,
                lora_alpha=self.args.lora_rank * 2,
                target_modules=["q_proj", "v_proj"],
                lora_dropout=0.1,
                bias="none",
                task_type="AUDIO_CLASSIFICATION"
            )

            self.wav2vec = get_peft_model(self.wav2vec, lora_config)
            self.wav2vec.print_trainable_parameters()
            logging.info("LoRA fine-tuning enabled")

        except ImportError:
            logging.warning("peft not installed - freezing base model instead")
            for param in self.wav2vec.parameters():
                param.requires_grad = False

    def _build_downstream(self, args):
        """Build the downstream classification head."""
        if args.downstream_model == "linear":
            return nn.Linear(self.hidden_size, self.output_class_num)

        elif args.downstream_model == "mlp":
            return nn.Sequential(
                nn.Linear(self.hidden_size, args.hidden_size),
                nn.ReLU(),
                nn.Dropout(0.1),
                nn.Linear(args.hidden_size, self.output_class_num)
            )

        else:
            return nn.Linear(self.hidden_size, self.output_class_num)

    def _pool_features(self, features, attention_mask=None):
        """Pool sequence features into a single vector."""
        if self.pooling_type == "mean":
            if attention_mask is not None:
                mask_expanded = attention_mask.unsqueeze(-1).expand(features.size())
                sum_features = torch.sum(features * mask_expanded, dim=1)
                sum_mask = torch.clamp(mask_expanded.sum(dim=1), min=1e-9)
                return sum_features / sum_mask
            else:
                return features.mean(dim=1)

        elif self.pooling_type == "max":
            return features.max(dim=1)[0]

        elif self.pooling_type == "attn":
            attn_weights = self.attention_pooling(features)
            if attention_mask is not None:
                attn_weights = attn_weights.masked_fill(attention_mask.unsqueeze(-1) == 0, -1e9)
                attn_weights = torch.softmax(attn_weights, dim=1)
            return (features * attn_weights).sum(dim=1)

        else:
            return features.mean(dim=1)

    def forward(self, x, length=None):
        """
        Forward pass.

        Args:
            x: Input waveform [batch, time]
            length: Length of each sample [batch]

        Returns:
            logits: [batch, num_classes]
        """
        batch_size = x.size(0)

        # Create attention mask
        if length is not None:
            max_len = x.size(1)
            attention_mask = torch.arange(max_len, device=x.device).expand(batch_size, max_len)
            attention_mask = (attention_mask < length.unsqueeze(1)).long()
        else:
            attention_mask = torch.ones(batch_size, x.size(1), dtype=torch.long, device=x.device)

        # Extract features
        outputs = self.wav2vec(x, attention_mask=attention_mask)
        features = outputs.last_hidden_state

        # Pool features
        pooled = self._pool_features(features, attention_mask)

        # Classify
        logits = self.downstream(pooled)

        return logits